#!/usr/bin/env node
/**
 * Phase 5 T8 性能计时脚本（3B 双线 + 可用性冒烟）
 *
 * 指标（docs/agent-platform/05-非功能与验收边界.md §1.1 + 计划 D8 决策 3B）：
 *   1. groupChat       群聊消息发送 → SSE chat.message.new 到达   通过线 1000ms / 目标线 500ms
 *   2. firstToken      @ 触发 → Agent 回复消息到达（平台首字）    通过线 15000ms(D8) / 目标线 5000ms（双线记录）
 *   3. sessionStream   会话流：SSE 订阅建立 → 事件流到达          通过线 2000ms
 *   4. parallelAgents  并发 @ 压测 + 单请求失败隔离（通过线：全部受理成功或失败隔离不串扰）
 *   5. availability    可用性冒烟：连续健康检查 + SSE 断线重连    通过线 99.5%
 *
 * 成本预算：真实 opencode 调用 ≤ 3 次（firstToken 1 次 + parallelAgents 2 次）；
 * groupChat / sessionStream / availability 均为无 @ 消息 / 纯 HTTP，零调用。
 * 环境要求：本地 server(:3000) + web(:3001) 运行中，worker 在线（复用会话）。
 *
 * 用法：
 *   node scripts/perf/bench.mjs [--skip-first-token] [--skip-parallel]
 *        [--checks 20] [--json /tmp/perf-report.json] [--channel c_0000000012]
 *        [--task t_0000000006] [--agents a_product,a_architect]
 * 环境变量：SERVER_URL / WEB_URL / USERNAME / PASSWORD / CHANNEL_ID / TASK_ID / AGENTS
 * 脚本跑完即退出，不留长跑进程。
 */

import { createServer } from 'node:http';

/* ------------------------------------------------------------------ */
/* 配置                                                               */
/* ------------------------------------------------------------------ */

const env = process.env;
const SERVER_URL = (env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const WEB_URL = (env.WEB_URL || 'http://localhost:3001').replace(/\/$/, '');
const USERNAME = env.USERNAME || 'admin';
const PASSWORD = env.PASSWORD || 'admin123';
const CHANNEL_ID = env.CHANNEL_ID || 'c_0000000012';
const TASK_ID = env.TASK_ID || 't_0000000006';
const AGENTS = (env.AGENTS || 'a_product,a_architect').split(',').map((s) => s.trim()).filter(Boolean);

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(name);
const SKIP_FIRST_TOKEN = has('--skip-first-token');
const SKIP_PARALLEL = has('--skip-parallel');
const CHECKS_N = Number(flag('--checks', '20'));
const OUT_JSON = flag('--json', null);
const OVERRIDE_CHANNEL = flag('--channel', null);
const OVERRIDE_TASK = flag('--task', null);
const OVERRIDE_AGENTS = flag('--agents', null);

const channelId = OVERRIDE_CHANNEL || CHANNEL_ID;
const taskId = OVERRIDE_TASK || TASK_ID;
const agents = OVERRIDE_AGENTS ? OVERRIDE_AGENTS.split(',').map((s) => s.trim()).filter(Boolean) : AGENTS;

// 指标阈值（ms）
const LINES = {
  groupChat: { passLine: 1000, targetLine: 500 },
  firstToken: { passLine: 15000, targetLine: 5000 },
  sessionStream: { passLine: 2000, targetLine: null },
  availability: { passLine: 99.5, targetLine: null }, // %
};

// 等待超时（ms）
const FIRST_TOKEN_TIMEOUT = 60_000;
const PARALLEL_REPLY_TIMEOUT = 60_000;
const GROUP_CHAT_SAMPLES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* HTTP / SSE 工具                                                     */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** 解析单条 SSE 帧文本（`id: xxx\ndata: {...}`）→ {id, type, payload, timestamp}。 */
function parseSSEFrame(frame) {
  let id = null;
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  // 心跳帧（id 为 null）业务方自行忽略
  return { id: parsed.id ?? id, type: parsed.type, payload: parsed.payload, timestamp: parsed.timestamp };
}

/**
 * 手写 SSE 客户端（node 无原生 EventSource）：
 * - connect() 发起 fetch 流式读取，resolve 后 onEvent 持续回调（返回首帧到达时刻）
 * - waitFor(predicate, timeout) 等待首个匹配业务事件
 * - close() 通过 AbortController 中断读取
 */
class SSEConnection {
  constructor(url) {
    this.url = url;
    this.controller = new AbortController();
    this.listeners = new Set();
    this.connectedAt = null;
    this.firstEventAt = null;
    this.error = null;
    this.closed = false;
  }

  async connect() {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(this.url, { signal: this.controller.signal });
    } catch (e) {
      this.error = e;
      throw e;
    }
    if (!res.ok || !res.body) {
      this.error = new Error(`SSE 连接失败 HTTP ${res.status}`);
      throw this.error;
    }
    this.connectedAt = Date.now();
    const connectMs = this.connectedAt - t0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!frame.trim()) continue;
            const ev = parseSSEFrame(frame);
            if (!ev) continue;
            if (this.firstEventAt === null) this.firstEventAt = Date.now();
            for (const fn of this.listeners) {
              try {
                fn(ev);
              } catch {
                /* 订阅者异常不阻断 */
              }
            }
          }
        }
      } catch (e) {
        /* abort/流中断：正常关闭路径 */
      }
    })();
    return { connectMs, connectedAt: this.connectedAt };
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 等待首个满足 predicate 的业务事件（心跳帧 id=null 忽略）。超时抛错。 */
  waitFor(predicate, { timeout = 30_000, label = '事件' } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待 ${label} 超时（${timeout}ms）`));
      }, timeout);
      const off = this.onEvent((ev) => {
        if (ev.id == null) return; // 心跳
        if (predicate(ev)) {
          clearTimeout(timer);
          off();
          resolve(ev);
        }
      });
      if (this.error) {
        clearTimeout(timer);
        off();
        reject(this.error);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
  }
}

/* ------------------------------------------------------------------ */
/* 指标实现                                                           */
/* ------------------------------------------------------------------ */

/** 1. 群聊消息 ≤1s：POST 无 @ 消息 → SSE chat.message.new 到达（服务端零模型调用）。 */
async function benchGroupChat({ token, samples = GROUP_CHAT_SAMPLES }) {
  const results = [];
  for (let i = 0; i < samples; i++) {
    const sse = new SSEConnection(
      `${SERVER_URL}/api/v1/events?token=${encodeURIComponent(token)}&scope=channel:${channelId}`,
    );
    await sse.connect();
    const t0 = Date.now();
    const post = await api(`/api/v1/channels/${channelId}/messages`, {
      method: 'POST',
      token,
      body: { text: `[perf/groupChat] 性能计时采样 ${i + 1}（无 @，零模型调用）`, mentions: [] },
    });
    if (post.status !== 201) {
      sse.close();
      throw new Error(`发消息失败 HTTP ${post.status}: ${JSON.stringify(post.data)}`);
    }
    const msgId = post.data?.message?.id;
    const ev = await sse.waitFor(
      (e) => e.type === 'chat.message.new' && e.payload?.message?.id === msgId,
      { timeout: 10_000, label: `groupChat 采样 ${i + 1} SSE 回流` },
    );
    const latency = Date.now() - t0;
    const sseLatency = Date.now() - new Date(ev.payload.message.createdAt).getTime();
    results.push({ sample: i + 1, latencyMs: latency, sseDeliveryMs: sseLatency, messageId: msgId });
    sse.close();
    await sleep(150);
  }
  const sorted = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const measuredMs = Math.round(sorted[Math.floor(sorted.length / 2)]);
  const { passLine, targetLine } = LINES.groupChat;
  return {
    measured: measuredMs,
    measuredUnit: 'ms',
    passLine,
    targetLine,
    pass: measuredMs <= passLine,
    target: measuredMs <= targetLine,
    samples: results,
    note: 'POST 发出 → SSE chat.message.new 到达（无 @ 消息，零 opencode 调用）',
  };
}

/** 3. 会话流 ≤2s：SSE 订阅建立 → 事件流到达（含增量渲染：订阅后 POST 新消息）。 */
async function benchSessionStream({ token }) {
  const t0 = Date.now();
  const sse = new SSEConnection(
    `${SERVER_URL}/api/v1/events?token=${encodeURIComponent(token)}&scope=channel:${channelId}`,
  );
  const { connectMs } = await sse.connect();
  // 等待首个业务事件（backlog 首帧，近实时到达）
  await sse.waitFor(() => true, { timeout: 5_000, label: '首帧' });
  const firstEventMs = Date.now() - t0;
  // 增量渲染：订阅建立后 POST 无 @ 消息，测新事件到达延迟
  const post = await api(`/api/v1/channels/${channelId}/messages`, {
    method: 'POST',
    token,
    body: { text: '[perf/sessionStream] 会话流增量渲染计时（无 @）', mentions: [] },
  });
  const msgId = post.data?.message?.id;
  const ev = await sse.waitFor(
    (e) => e.type === 'chat.message.new' && e.payload?.message?.id === msgId,
    { timeout: 10_000, label: '增量事件' },
  );
  const incrementalMs = Date.now() - new Date(ev.payload.message.createdAt).getTime();
  sse.close();
  const measuredMs = firstEventMs;
  const { passLine } = LINES.sessionStream;
  return {
    measured: measuredMs,
    measuredUnit: 'ms',
    passLine,
    targetLine: null,
    pass: measuredMs <= passLine,
    connectMs,
    firstEventMs,
    incrementalMs,
    note: '订阅建立（HTTP 发起）→ 首个业务事件到达；incrementalMs=新消息事件到达延迟',
  };
}

/** 2. @ 首字（双线 15s/5s）：@ 现有 Agent（复用会话）→ 回复消息到达。真实 opencode 调用 ×1。 */
async function benchFirstToken({ token, agentId }) {
  const t0 = Date.now();
  const post = await api(`/api/v1/channels/${channelId}/messages`, {
    method: 'POST',
    token,
    body: {
      text: `[perf/firstToken] 首字计时 @${agentId}（真实调用，请简要回复一句话）`,
      mentions: [{ type: 'agent', agentId }],
    },
  });
  if (post.status !== 201) {
    throw new Error(`@ 消息发送失败 HTTP ${post.status}: ${JSON.stringify(post.data)}`);
  }
  const userMsgId = post.data?.message?.id;
  const triggers = post.data?.triggers ?? [];
  const dispatched = triggers.filter((t) => t.status === 'dispatched');
  if (dispatched.length === 0) {
    return {
      measured: null,
      measuredUnit: 'ms',
      passLine: LINES.firstToken.passLine,
      targetLine: LINES.firstToken.targetLine,
      pass: false,
      target: false,
      triggers,
      note: '无 dispatched 目标（会话缺失/Agent 已移除），无法测首字——未产生真实调用',
    };
  }

  // 轮询 trigger-results 精确关联本 @ 消息的回复（回复落库后立即可查，与 SSE 广播近乎同步）：
  // 避免 SSE 连接建立后的 backlog 重放历史回复（同 Agent 之前已有回复消息时 waitFor 会误命中）。
  let got;
  {
    const deadline = Date.now() + FIRST_TOKEN_TIMEOUT;
    let replyMessageId = null;
    while (Date.now() < deadline) {
      const r = await api(`/api/v1/channels/${channelId}/trigger-results/${userMsgId}`, { token });
      const tr = (r.data?.triggers ?? []).find((t) => t.agentId === agentId);
      if (tr?.replyMessageId) {
        replyMessageId = tr.replyMessageId;
        break;
      }
      await sleep(500);
    }
    got = replyMessageId
      ? { via: 'poll', replyMessageId }
      : { error: `trigger-results 等待首字回复超时（${FIRST_TOKEN_TIMEOUT / 1000}s）` };
  }

  const measuredMs = got.error ? null : Date.now() - t0;
  const { passLine, targetLine } = LINES.firstToken;
  return {
    measured: measuredMs,
    measuredUnit: 'ms',
    passLine,
    targetLine,
    pass: measuredMs !== null && measuredMs <= passLine,
    target: measuredMs !== null && measuredMs <= targetLine,
    ...(got.error ? { error: got.error } : { via: got.via, replyMessageId: got.replyMessageId }),
    userMessageId: userMsgId,
    triggers,
    note: '真实 opencode 调用 1 次；双线记录：passLine=15s(D8 决策 3B)、targetLine=5s(05 篇)，超目标线不阻断',
  };
}

/** 4. 并发 @ 压测 + 失败隔离：并发 POST 4 条（2 真实 @ + 1 非法 @ + 1 无 @）。真实调用 ×2。 */
async function benchParallelAgents({ token }) {
  const ghost = { type: 'agent', agentId: 'a_ghost_not_in_team' };
  const arch = agents[0];
  const prod = agents[1] || agents[0];
  const payloads = [
    { text: `[perf/parallel] 并发 A @${arch}（请一句话回应）`, mentions: [{ type: 'agent', agentId: arch }] },
    { text: `[perf/parallel] 并发 B @${prod}（请一句话回应）`, mentions: [{ type: 'agent', agentId: prod }] },
    { text: '[perf/parallel] 并发 C @幽灵（非法 Agent，应 400 拒绝）', mentions: [ghost] },
    { text: '[perf/parallel] 并发 D 普通消息（无 @，零模型调用）', mentions: [] },
  ];

  // 全部并发发出
  const posts = await Promise.allSettled(
    payloads.map((p) =>
      api(`/api/v1/channels/${channelId}/messages`, { method: 'POST', token, body: p }),
    ),
  );

  const summary = posts.map((p, i) => {
    if (p.status === 'rejected') return { index: i, accepted: false, error: String(p.reason) };
    return {
      index: i,
      accepted: p.value.status === 201,
      httpStatus: p.value.status,
      messageId: p.value.data?.message?.id ?? null,
      dispatched: (p.value.data?.triggers ?? []).filter((t) => t.status === 'dispatched').length,
      triggers: p.value.data?.triggers ?? [],
    };
  });

  const accepted = summary.filter((s) => s.accepted);
  const rejected = summary.filter((s) => !s.accepted);
  const dispatchedCount = summary.reduce((n, s) => n + s.dispatched, 0);

  // 等待真实 dispatch 回流（2 个目标 Agent）：用 trigger-results 精确关联各 @ 消息的回复，
  // 避免 SSE backlog 重放历史回复造成误匹配（@ 前已有同 Agent 回复消息时 waitFor 会命中历史事件）。
  const dispatchedMsgIds = new Map(); // agentId -> userMsgId
  for (let i = 0; i < payloads.length; i++) {
    const agentId = payloads[i].mentions?.[0]?.agentId;
    if (i < 2 && agentId && summary[i]?.accepted) dispatchedMsgIds.set(agentId, summary[i].messageId);
  }
  const replies = [];
  const deadline = Date.now() + PARALLEL_REPLY_TIMEOUT;
  for (const agentId of [arch, prod]) {
    const userMsgId = dispatchedMsgIds.get(agentId);
    if (!userMsgId) {
      replies.push({ agentId, replied: false, error: '无 dispatched 目标（未受理）' });
      continue;
    }
    let replyMessageId = null;
    while (Date.now() < deadline) {
      const r = await api(`/api/v1/channels/${channelId}/trigger-results/${userMsgId}`, { token });
      const tr = (r.data?.triggers ?? []).find((t) => t.agentId === agentId);
      if (tr?.replyMessageId) {
        replyMessageId = tr.replyMessageId;
        break;
      }
      await sleep(500);
    }
    replies.push(
      replyMessageId
        ? { agentId, replied: true, replyMessageId }
        : { agentId, replied: false, error: `trigger-results 等待回流超时（${PARALLEL_REPLY_TIMEOUT / 1000}s）` },
    );
  }

  const allReplied = replies.every((r) => r.replied);
  // 通过线（05 篇 §1.1/§1.3）：并发 @ 全部受理成功（201 + dispatched），失败请求被隔离不串扰
  const allRealDispatchedAccepted = summary.slice(0, 2).every((s) => s.accepted && s.dispatched > 0);
  const isolationOk =
    rejected.every((r) => r.index === 2 && r.httpStatus === 400) && // 仅非法 @ 被拒
    summary[3]?.accepted === true; // 无 @ 消息不受影响
  const pass = allRealDispatchedAccepted && isolationOk;

  return {
    concurrent: summary.length,
    dispatchedTargets: dispatchedCount,
    accepted: summary.filter((s) => s.accepted).length,
    rejected: rejected.map((r) => ({ index: r.index, httpStatus: r.httpStatus, messageId: r.messageId })),
    isolation: {
      invalidMentionRejected: rejected.length > 0 && rejected[0].httpStatus === 400,
      othersAccepted: summary.filter((s) => s.index !== 2).every((s) => s.accepted),
    },
    replies,
    allReplied,
    pass,
    note: `并发 ${summary.length} 条（2 真实 @ + 1 非法 @ + 1 无 @），真实 opencode 调用 2 次；通过线=并发受理全部成功且失败隔离不串扰（回流情况见 replies）`,
  };
}

/** 5. 可用性冒烟 ≥99.5%：连续健康检查 + SSE 断线重连。零模型调用。 */
async function benchAvailability({ token, checks = CHECKS_N }) {
  // a. 连续健康检查
  let ok = 0;
  const latencies = [];
  for (let i = 0; i < checks; i++) {
    const t0 = Date.now();
    const res = await fetch(`${SERVER_URL}/api/v1/health`);
    latencies.push(Date.now() - t0);
    if (res.status === 200) ok++;
    await sleep(120);
  }
  const availabilityPct = Number(((ok / checks) * 100).toFixed(2));

  // b. SSE 断线重连：建立 → 收首帧 → 断开 → since 重连 → 期间触发新事件验证实时流恢复
  //    用 channel scope（频道有历史事件，backlog 立即到达，保证首帧不空）
  const sse1 = new SSEConnection(
    `${SERVER_URL}/api/v1/events?token=${encodeURIComponent(token)}&scope=channel:${channelId}`,
  );
  await sse1.connect();
  const first = await sse1.waitFor(() => true, { timeout: 5_000, label: '断线前首帧' });
  const since = first.id;
  sse1.close();
  await sleep(200);
  const sse2 = new SSEConnection(
    `${SERVER_URL}/api/v1/events?token=${encodeURIComponent(token)}&scope=channel:${channelId}&since=${encodeURIComponent(since)}`,
  );
  const t0 = Date.now();
  await sse2.connect();
  // 断线期间/重连后触发新事件（无 @，零模型调用）：验证 since 续拉 + 实时流双通道恢复
  const post = await api(`/api/v1/channels/${channelId}/messages`, {
    method: 'POST',
    token,
    body: { text: '[perf/availability] 断线重连后事件触发（无 @）', mentions: [] },
  });
  const targetId = post.data?.message?.id;
  let ev2 = null;
  try {
    ev2 = await sse2.waitFor(
      (e) => e.type === 'chat.message.new' && e.payload?.message?.id === targetId,
      { timeout: 8_000, label: '重连后事件' },
    );
  } catch (err) {
    ev2 = null;
  }
  const reconnectMs = Date.now() - t0;
  const reconnectOk = ev2 != null;
  sse2.close();

  const { passLine } = LINES.availability;
  const pass = availabilityPct >= passLine && reconnectOk;
  return {
    measured: availabilityPct,
    measuredUnit: '%',
    passLine,
    targetLine: null,
    pass,
    checks,
    success: ok,
    availabilityPct,
    latenciesMs: latencies,
    reconnect: { ok: reconnectOk, since, reconnectMs, lastEventId: ev2?.id ?? null },
    note: '连续健康检查（GET /api/v1/health）+ SSE 断线后 since 续拉重连；纯 HTTP 零模型调用',
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  // 登录
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD },
  });
  if (login.status !== 200 || !login.data?.accessToken) {
    throw new Error(`登录失败 HTTP ${login.status}: ${JSON.stringify(login.data)}`);
  }
  const token = login.data.accessToken;

  const report = {
    timestamp: new Date().toISOString(),
    env: { serverUrl: SERVER_URL, webUrl: WEB_URL, channelId, taskId, agents },
    lines: { groupChat: LINES.groupChat, firstToken: LINES.firstToken, sessionStream: LINES.sessionStream, availability: LINES.availability },
    results: {},
  };

  // 可用性冒烟（先跑：纯 HTTP，若 server 异常后续指标都不必跑）
  report.results.availability = await benchAvailability({ token });

  // 群聊消息（零模型调用）
  report.results.groupChat = await benchGroupChat({ token });

  // 会话流（零模型调用）
  report.results.sessionStream = await benchSessionStream({ token });

  // @ 首字（真实调用 ×1）
  if (!SKIP_FIRST_TOKEN) {
    report.results.firstToken = await benchFirstToken({ token, agentId: agents[0] });
  }

  // 并发 + 失败隔离（真实调用 ×2）
  if (!SKIP_PARALLEL) {
    report.results.parallelAgents = await benchParallelAgents({ token });
  }

  const summary = {
    groupChat: report.results.groupChat?.pass,
    firstToken: report.results.firstToken?.pass,
    sessionStream: report.results.sessionStream?.pass,
    parallelAgents: report.results.parallelAgents?.pass,
    availability: report.results.availability?.pass,
  };
  report.summary = summary;
  report.allPass = Object.values(summary).every((v) => v === true);

  if (OUT_JSON) {
    const fs = await import('node:fs');
    fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
    console.log(`\nJSON 报告已写入: ${OUT_JSON}`);
  }
  console.log('\n===== T8 性能报告 =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('========================');

  // 退出码：全过 0；任一失败 1
  process.exit(report.allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(`[perf] 失败: ${err.message}`);
  process.exit(2);
});
