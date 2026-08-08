/**
 * T6 RegistryClient：注册 + 心跳 HTTP 客户端（架构决策 D1 全 push 三通道之注册/心跳）。
 *
 * - registerWorker：POST {serverUrl}/api/v1/workers/register（X-Worker-Token 鉴权，
 *   body = RegisterWorkerPayload）→ 响应 { workerId, heartbeatIntervalMs, serverTime }；
 *   非 2xx 抛错。
 * - sendHeartbeat：POST {serverUrl}/api/v1/workers/{id}/heartbeat（header 同，
 *   body = HeartbeatWorkerPayload）。失败抛错，由调用方（index.ts 定时器）捕获记录。
 * - registerWorkerWithRetry：注册失败指数退避重试（1s/2s/4s/8s/16s/30s 封顶），
 *   网络错/非 2xx 均视为失败；重试耗尽仍失败抛错（启动即失败，worker 退出）。
 *
 * worker 独立进程铁律：不 import server 代码（WORKER_TOKEN_HEADER 本地常量双写，
 * 与 server/src/workers/workers.constants.ts 的 x-worker-token 保持一致）。
 */

import {
  HeartbeatResponse,
  HeartbeatWorkerPayload,
  McpStatusEntry,
  RegisterWorkerPayload,
  WorkerCapabilities,
  WorkerCommand,
  WorkerHealth,
  WorkerLoad,
} from '../protocol/worker-protocol';

/** X-Worker-Token 鉴权 header（对齐 server workers.constants.ts WORKER_TOKEN_HEADER）。 */
export const WORKER_TOKEN_HEADER = 'x-worker-token';

/** server 全局路由前缀（对齐 server/src/main.ts setGlobalPrefix('api/v1')）。 */
const API_PREFIX = '/api/v1';

/** POST /workers/register 成功响应（对齐 server workers.service.ts register 返回）。 */
export interface RegisterResponse {
  workerId: string;
  heartbeatIntervalMs: number;
  serverTime: string;
}

export interface RegistryClientOptions {
  /** server 基址（如 http://localhost:3000），尾斜杠容忍 */
  serverUrl: string;
  /** X-Worker-Token 鉴权 token（config.workerToken） */
  workerToken: string;
  /** worker 全局唯一 id（config.workerId） */
  workerId: string;
  /** 可选显示名（config.workerName） */
  workerName?: string;
  /** opencode CLI 版本（OpencodeServer.version / detectOpencodeVersion） */
  opencodeVersion: string;
  /** 能力声明（T6 由 index.ts 组装：maxInstances=1 + git 工具族） */
  capabilities: WorkerCapabilities;
  /** 注册时负载快照（默认 { instances: 0 }） */
  load?: WorkerLoad;
  /** fetch 注入点（测试用）；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
}

export interface HeartbeatOptions {
  serverUrl: string;
  workerToken: string;
  workerId: string;
  load: WorkerLoad;
  health: WorkerHealth;
  /** T8c：MCP 服务器三态快照（节流探测结果，可选） */
  mcpStatus?: McpStatusEntry[];
  fetchImpl?: typeof fetch;
}

export interface RegisterRetryOptions {
  /** 指数退避基数 ms；默认 1000（序列 1s/2s/4s/8s/16s/...） */
  baseDelayMs?: number;
  /** 单次退避封顶 ms；默认 30000 */
  maxDelayMs?: number;
  /** 最大重试次数（总尝试 = maxRetries + 1）；默认 8 */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  logger?: { warn(message: string): void };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 拼接 API 路径（serverUrl 尾斜杠容忍）。 */
export function apiUrl(serverUrl: string, path: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}${API_PREFIX}${path}`;
}

/**
 * POST {serverUrl}/api/v1/workers/register：单次注册。
 * 非 2xx 抛错（含 401 token 无效 / 400 DTO 校验失败），不做内部重试。
 */
export async function registerWorker(opts: RegistryClientOptions): Promise<RegisterResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const body: RegisterWorkerPayload = {
    workerId: opts.workerId,
    name: opts.workerName,
    opencodeVersion: opts.opencodeVersion,
    capabilities: opts.capabilities,
    load: opts.load ?? { instances: 0 },
  };
  const response = await fetchImpl(apiUrl(opts.serverUrl, '/workers/register'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [WORKER_TOKEN_HEADER]: opts.workerToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`注册失败: HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as RegisterResponse;
}

/**
 * POST {serverUrl}/api/v1/workers/{id}/heartbeat：单次心跳。
 * 失败抛错（网络错 / 非 2xx，404 = worker 未注册），由调用方定时器捕获记录。
 * T4a：返回解析后的响应体（含可选 commands 下行命令），调用方据此分派处理。
 */
export async function sendHeartbeat(opts: HeartbeatOptions): Promise<HeartbeatResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const body: HeartbeatWorkerPayload = {
    workerId: opts.workerId,
    load: opts.load,
    health: opts.health,
    ...(opts.mcpStatus !== undefined && opts.mcpStatus.length > 0
      ? { mcpStatus: opts.mcpStatus }
      : {}),
  };
  const response = await fetchImpl(
    apiUrl(opts.serverUrl, `/workers/${encodeURIComponent(opts.workerId)}/heartbeat`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [WORKER_TOKEN_HEADER]: opts.workerToken,
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`心跳失败: HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as HeartbeatResponse;
}

/** T4a：从心跳响应提取待执行命令（无命令返回空数组，兼容旧 server）。 */
export function extractCommands(response: HeartbeatResponse): WorkerCommand[] {
  return response.commands ?? [];
}

/**
 * 注册 + 指数退避重试：1s/2s/4s/8s/16s/30s 封顶（maxDelayMs）。
 * 网络错与非 2xx 均计入失败；重试耗尽仍失败则抛错（worker 启动即失败）。
 */
export async function registerWorkerWithRetry(
  opts: RegistryClientOptions,
  retryOpts: RegisterRetryOptions = {},
): Promise<RegisterResponse> {
  const baseDelayMs = retryOpts.baseDelayMs ?? 1000;
  const maxDelayMs = retryOpts.maxDelayMs ?? 30_000;
  const maxRetries = retryOpts.maxRetries ?? 8;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      retryOpts.logger?.warn?.(`[registry] 注册失败，${delay}ms 后进行第 ${attempt} 次重试`);
      await sleep(delay);
    }
    try {
      return await registerWorker({ ...opts, fetchImpl: retryOpts.fetchImpl ?? opts.fetchImpl });
    } catch (err) {
      lastError = err;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`注册重试 ${maxRetries} 次仍失败: ${message}`);
}
