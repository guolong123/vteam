/**
 * T8c MCP 状态探测器（**v2：直接查 serve 的 HTTP API**，不再 shell out 到 opencode CLI）。
 *
 * ⚠️ **v2 的关键事实（本轮修复的根因）**：v2 的 CLI 子命令**不连 worker 自己拉起的那个 serve**。
 * `opencode mcp list` 绑的是**共享后台服务**（默认端口 49374），读的是**它自己那套配置作用域**
 * —— 实测裸跑 `opencode mcp list` 答 `No MCP servers configured`，而 worker 的 serve 明明
 * `GET /api/mcp` → `vteam` **connected**。⇒ **用 CLI 观测 serve 在 v2 下原理上就是错的**
 * （观测到的是另一个作用域 ⇒ 静默的错误答案）。
 * ⇒ 本探针改为**直接读 worker 自己那个 serve 的 `GET /api/mcp`**（Basic Auth 用 serve 密码）。
 *
 * - 数据源：`GET /api/mcp`（v2 契约 `Mcp.Server[]`：`{name, status:{status,error?}, integrationID?}`）
 * - 响应形态：v2 返回 `{location, data:[...]}`；**裸数组**也容忍（复用驱动的 `unwrapV2List`）
 * - 五态（v2 契约 `Mcp.Status.*`）：`connected` / `failed` / `needs_auth` / `pending` / `disabled`
 * - 探测结局（**探针层面**，与上面的服务器状态是两个维度）：
 *   `ok`（读到合法列表）/ `probe_failed`（**探针自身失败**：HTTP 失败 / 响应不是 v2 形状 / 非法 JSON）
 * - `probe_failed` **绝不**产出「无 MCP 服务器」的结论（保留上次结果 + 显式告警）
 * - **30-60s 节流**（Metis 高优补项 7：不能每 10s 心跳都打一次 serve）——节流窗口内返回上次快照
 *
 * ⚠️ **五态 → 线契约是 1:1，不折叠**（详见 `V2_STATUS_TO_VTEAM` 的注释）：
 * `pending`（瞬态：还在连接中）与 `disabled`（已配置但停用）**都不是 `failed`**——
 * 把它们折叠进旧三态等于**谎报**（把"还在连"报成"连接失败"、把"配置停用"报成"故障"）。
 * ⇒ 线契约在**两端同时**扩到五态：worker 的 `McpServerStatus`（protocol/worker-protocol.ts）
 *   与 server 的 `MCP_STATUS`（mcp-servers/dto/mcp-status.dto.ts 的 `@IsIn`）。
 *   **两端必须同步**：server 的 `@IsIn` 不同步扩 ⇒ 整个心跳被 400 拒（worker 掉线）。
 *
 * worker 独立进程铁律：不 import server 代码。本轮只探测状态，不做 OAuth auth 流程
 * （11 §5.8：OAuth 由 worker 本地完成，控制面仅展示 needs_auth 引导）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { unwrapV2List } from '../driver/v2-driver';

/**
 * MCP 服务器可用性状态（**v2 的五个状态**，1:1 上报，不折叠）。
 *
 * - `connected`：已连接可用
 * - `failed`：连接/拉取工具失败（v2 的 `status.error` 带原因）
 * - `needs_auth`：远程服务器要求 OAuth 未授权（v2 的 `status.error` 带原因）
 * - `pending`：**瞬态**，还在连接中（v2 新增；旧三态里没有这一档）
 * - `disabled`：已配置但**停用**（v2 新增；旧三态里没有这一档）
 */
export type McpStatus = 'connected' | 'failed' | 'needs_auth' | 'pending' | 'disabled';

/**
 * 探测结局（**探针层面**，与上面五态是两个维度）。
 *
 * - `ok`：读到了一份**合法的** MCP 服务器列表（列表为空 = 真的没配 MCP 服务器）；
 * - `probe_failed`：**探针自身失败**（serve 不可达 / HTTP 非 2xx / 响应不是 JSON /
 *   响应不是 v2 的 `/api/mcp` 形状）。
 *
 * ⚠️ `probe_failed` **绝不能**被解读为「无 MCP 服务器」——那正是 v1→v2 迁移期
 * 「探针坏了却看起来一切正常」的静默误报。
 */
export type McpProbeOutcome = 'ok' | 'probe_failed';

/** 单台 MCP 服务器的状态上报条目（serverName 与 mcp_servers.name 对应）。 */
export interface McpStatusEntry {
  serverName: string;
  status: McpStatus;
}

/**
 * 探测快照（一次探测的完整结论）。
 *
 * - `entries`：状态条目（**与心跳载荷同形**：`{serverName, status}`）。
 *   探测失败时为**上次成功的结果**（不是空数组冒充「无 MCP 服务器」）。
 * - `outcome`：`ok` / `probe_failed`。
 * - `reason`：失败原因（`outcome === 'probe_failed'` 时非空，供日志/告警/排障）。
 */
export interface McpStatusSnapshot {
  entries: McpStatusEntry[];
  outcome: McpProbeOutcome;
  reason?: string;
}

/**
 * 内置 vteam MCP 的注入名（新名 `vteam`；存量部署旧名 `keta-platform`，
 * 改名迁移见 server/prisma/seed.ts）。探测失败时对两者都做集群内地址判定。
 */
export const BUILTIN_MCP_SERVERS = ['vteam', 'keta-platform'] as const;

/**
 * 判定内置 MCP 地址是否为集群内服务名（compose 的 `server` / k8s 的 `vteam-server`）。
 * 集群外 worker 无法解析这类地址，是「内置 MCP 不可达」的典型根因。
 */
export function isClusterInternalUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostname === 'server' || hostname === 'vteam-server';
}

/**
 * v2 `/api/mcp` 的单条服务器项（`Mcp.Server`）。
 *
 * `status` 契约上是对象 `{status, error?}`；这里**同时容忍裸字符串**（防御上游形态漂移）。
 */
interface V2McpServer {
  name?: unknown;
  status?: unknown;
}

/**
 * 探测函数形态（测试可注入）：返回 serve `GET /api/mcp` 的**原始响应体**（JSON）。
 *
 * 失败以**抛错**表达（探针把异常归一成 `probe_failed` + 保留上次结果）。
 */
export type McpStatusProbeFn = () => Promise<unknown>;

/** serve 端点（baseUrl + Basic Auth 密码；密码为空 = 不鉴权）。 */
export interface McpServeEndpoint {
  baseUrl: string;
  password: string | null;
}

export interface McpStatusProbeOptions {
  /** 探测节流间隔 ms（默认 30_000，Metis 高优补项 7：30-60s 节流）。 */
  throttleMs?: number;
  /**
   * 单次 HTTP 请求超时 ms（默认 5_000）。
   *
   * 为什么比旧 CLI 探测的 15s 更短：探测发生在**心跳 await 链路**上（心跳周期 10s），
   * 超时太长会把心跳拖到被判离线；serve 在回环上，5s 足够。
   */
  timeoutMs?: number;
  /**
   * serve 端点提供器（**每次探测时读取**——serve 重启可能换端口，届时自动跟上）。
   *
   * 必须注入**serve 的实际配置**（baseUrl + effectiveServerPassword），不得另从环境变量读
   * 一份——否则会和 serve 的真实鉴权/端口漂移（v2 恒开 Basic Auth，密码错了全线 401）。
   */
  endpoint?: () => McpServeEndpoint | undefined;
  /** fetch 注入点（单测；默认全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /**
   * 整个探测函数的注入点（单测）——返回 serve `GET /api/mcp` 的原始响应体。
   * 注入后 endpoint/fetchImpl 不再被使用。
   */
  probeFn?: McpStatusProbeFn;
  /**
   * opencode 工作目录（内置 vteam MCP 的注入配置落点 <workDir>/opencode.json）。
   * 只用于**失败时的地址引导**（读 `mcp.<serverName>.url`），不参与探测本身。
   */
  cwd?: string;
  /** 日志（可选，默认 console）。 */
  logger?: { warn(message: string): void };
  /**
   * 内置 vteam MCP 配置 URL 解析器（默认读 <cwd>/opencode.json 的 `mcp.<serverName>.url`）。
   * 探测到内置 MCP failed 时用它取实际注入地址，判定集群内服务名后输出 WORKER_MCP_URL 引导。
   */
  resolveBuiltinMcpUrl?: (serverName: string) => string | undefined;
}

/**
 * v2 五态 → vteam 上报态（**1:1，不折叠**）。
 *
 * ⚠️ **为什么不能折叠进旧三态**（这是本轮的关键决策，写清楚以免后来者"顺手简化"）：
 * - `pending`（瞬态：还在连接中）**不是** `failed`：它几秒后就变成 `connected`，
 *   报成 `failed` 等于**谎报一次故障**（控制面/运维会去查一个根本没坏的服务）；
 * - `disabled`（已配置但停用）**不是** `failed`：它是配置选择，不是错误，
 *   报成 `failed` 会把"人为关掉"误报成"环境故障"。
 * ⇒ 两者都**无法**在旧三态里被忠实表达 ⇒ **线契约两端同时扩到五态**
 * （worker `McpServerStatus` + server `MCP_STATUS` 的 `@IsIn`；不同步 ⇒ 心跳 400）。
 */
const V2_STATUS_TO_VTEAM: Record<string, McpStatus> = {
  connected: 'connected',
  failed: 'failed',
  needs_auth: 'needs_auth',
  pending: 'pending',
  disabled: 'disabled',
};

/**
 * 未知/缺失状态 → 上报态的**保守兜底**。
 *
 * 为什么不是"跳过该服务器"：跳过 = 服务器从面板上**静默消失**（运维以为没配）。
 * 为什么不是"按 connected"：那是**谎报可用**（最危险的一种错）。
 * ⇒ 兜底取"最保守的不可用"投影 `failed`，同时**显式告警**（原始状态串进日志），
 * 让"上游多了一个我们不认识的状态"这件事**响亮**而不是静默。
 */
const UNKNOWN_STATUS_FALLBACK: McpStatus = 'failed';

/** 解析结论（细节版）。 */
export interface McpStatusParseResult {
  /** 状态条目（与心跳载荷同形）。 */
  entries: McpStatusEntry[];
  /**
   * 状态**无法识别**的服务器（名字 + 原始状态串）——显式暴露，绝不静默。
   * （已按 `UNKNOWN_STATUS_FALLBACK` 保守投影进 entries，这里只是留证据。）
   */
  unknownStatuses: Array<{ serverName: string; rawStatus: string }>;
  /** 名字缺失/非法的条目数（无法上报——线契约要求 serverName 非空）。 */
  unnamedCount: number;
}

/** 取状态串：契约是对象 `{status}`；同时容忍裸字符串。 */
function readStatusText(status: unknown): string {
  if (typeof status === 'string') {
    return status.trim();
  }
  if (status !== null && typeof status === 'object') {
    const raw = (status as { status?: unknown }).status;
    if (typeof raw === 'string') {
      return raw.trim();
    }
  }
  return '';
}

/**
 * 解析 serve `GET /api/mcp` 的响应体为状态条目。
 *
 * - **形态容忍**：`{location, data:[...]}`（v2 实测）与**裸数组**都认
 *   （复用驱动的 `unwrapV2List`——基线漂移的单一收敛点）；
 * - **五态 1:1 映射**（见 `V2_STATUS_TO_VTEAM`）；未知状态 → 保守兜底 `failed` + 记入
 *   `unknownStatuses`（显式，不静默）；
 * - 名字缺失/空 ⇒ 不产出条目（线契约要求 `serverName` 非空），但**计数上报**（不静默）。
 */
export function parseMcpStatusPayload(payload: unknown): McpStatusParseResult {
  const servers = unwrapV2List<V2McpServer>(payload);
  const entries: McpStatusEntry[] = [];
  const unknownStatuses: Array<{ serverName: string; rawStatus: string }> = [];
  let unnamedCount = 0;
  for (const server of servers) {
    if (server === null || typeof server !== 'object') {
      unnamedCount += 1;
      continue;
    }
    const name = typeof server.name === 'string' ? server.name.trim() : '';
    if (name === '') {
      unnamedCount += 1;
      continue;
    }
    const rawStatus = readStatusText(server.status);
    const mapped = V2_STATUS_TO_VTEAM[rawStatus];
    if (mapped === undefined) {
      unknownStatuses.push({ serverName: name, rawStatus });
    }
    entries.push({ serverName: name, status: mapped ?? UNKNOWN_STATUS_FALLBACK });
  }
  return { entries, unknownStatuses, unnamedCount };
}

/**
 * 响应体是否是 v2 `/api/mcp` 的形状（数组，或带 `data` 数组的对象）。
 *
 * 为什么要判：v2 对**非 v2 路由**返回 **200 + web SPA 的 HTML**（不是 404）；
 * 一个形状不对的 body 若被当成"空列表"，就是**静默误报"没有 MCP 服务器"**。
 * ⇒ 形状不对 ⇒ `probe_failed`（保留上次结果 + 告警），绝不产出空列表结论。
 */
export function isMcpStatusPayload(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return true;
  }
  if (payload !== null && typeof payload === 'object') {
    return Array.isArray((payload as { data?: unknown }).data);
  }
  return false;
}

/**
 * T8c MCP 状态探测器（带节流缓存）。
 *
 * getSnapshot() 为**异步**调用（HTTP），由心跳定时器驱动：距上次探测 < throttleMs
 * 返回缓存，否则重新请求 serve 的 `GET /api/mcp` 并更新缓存。默认 30s 节流
 * ——10s 心跳周期内最多每 3 次心跳打一次 serve。
 */
export class McpStatusProbe {
  private readonly throttleMs: number;
  private readonly timeoutMs: number;
  private readonly probeFn: McpStatusProbeFn;
  private readonly endpoint?: () => McpServeEndpoint | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: { warn(message: string): void };
  private readonly resolveBuiltinMcpUrl: (serverName: string) => string | undefined;
  /** 上次**成功**探测的条目（探测失败时保留，绝不用空数组冒充「无 MCP 服务器」）。 */
  private cached: McpStatusEntry[] = [];
  /** 上次探测的完整结论（节流窗口内直接复用同一对象）。 */
  private cachedSnapshot: McpStatusSnapshot = {
    entries: [],
    outcome: 'probe_failed',
    reason: '尚未探测',
  };
  private lastProbeAt = 0;
  /** 在途探测（并发调用复用同一次，避免同一窗口内打两次 serve）。 */
  private inFlight: Promise<McpStatusSnapshot> | null = null;

  constructor(options: McpStatusProbeOptions = {}) {
    this.throttleMs = options.throttleMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.probeFn = options.probeFn ?? (() => this.requestServeMcpStatus());
    this.logger = options.logger;
    this.resolveBuiltinMcpUrl =
      options.resolveBuiltinMcpUrl ?? ((serverName: string) => this.readInjectedUrl(options.cwd, serverName));
  }

  /**
   * 默认探测：读 **worker 自己那个 serve** 的 `GET /api/mcp`（Basic Auth 用 serve 密码）。
   *
   * ⚠️ **绝不能**改回 `opencode mcp list`（v2 的 CLI 是**另一个作用域**——共享后台服务，
   * 端口 49374——观测不到 worker 的 serve ⇒ 静默的错误答案）。
   */
  private async requestServeMcpStatus(): Promise<unknown> {
    const endpoint = this.endpoint?.();
    if (!endpoint || !endpoint.baseUrl) {
      throw new Error('serve 端点未就绪（baseUrl 为空）');
    }
    const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/api/mcp`;
    const headers: Record<string, string> = {};
    if (endpoint.password) {
      headers.Authorization = `Basic ${Buffer.from(`opencode:${endpoint.password}`, 'utf8').toString('base64')}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`GET /api/mcp HTTP ${res.status}`);
      }
      const raw = await res.text();
      try {
        return JSON.parse(raw) as unknown;
      } catch (err) {
        throw new Error(
          `GET /api/mcp 响应不是合法 JSON（${err instanceof Error ? err.message : String(err)}）：` +
            '被驱动端可能不是 opencode v2（v2 的非 v2 路由返回 200 + web SPA 的 HTML）',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 默认 URL 解析：从注入后的 <cwd>/opencode.json 读 `mcp.<name>.url`（探测的同一文件）。 */
  private readInjectedUrl(cwd: string | undefined, serverName: string): string | undefined {
    if (!cwd) {
      return undefined;
    }
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8'),
      ) as { mcp?: Record<string, { url?: string }> };
      return config?.mcp?.[serverName]?.url;
    } catch {
      return undefined;
    }
  }

  /** 内置 vteam MCP failed 且地址为集群内服务名时输出 WORKER_MCP_URL 引导（仅新探测路径，节流不重复）。 */
  private warnBuiltinUnreachable(entries: McpStatusEntry[]): void {
    const failed = entries.find(
      (e) =>
        BUILTIN_MCP_SERVERS.some((name) => e.serverName === name) && e.status === 'failed',
    );
    if (!failed) {
      return;
    }
    const url = this.resolveBuiltinMcpUrl(failed.serverName);
    if (!url || !isClusterInternalUrl(url)) {
      return;
    }
    this.logger?.warn?.(
      `[mcp-status] 内置 MCP 不可达：地址 ${url} 为集群内服务名，集群外 worker 请设置 WORKER_MCP_URL=<外部可达地址>（如 http://<控制面外部地址>/api/v1/platform-mcp）`,
    );
  }

  /**
   * 探测失败：记录**探针失败**（不是「无 MCP 服务器」），保留上次成功结果。
   */
  private fail(reason: string): McpStatusSnapshot {
    this.cachedSnapshot = { entries: this.cached, outcome: 'probe_failed', reason };
    this.logger?.warn?.(`[mcp-status] 探测失败（保留上次结果）: ${reason}`);
    return this.cachedSnapshot;
  }

  /**
   * 当前 MCP 状态快照（节流缓存 + **探测结局**）。
   *
   * 窗口外重新探测，两种结局：
   * - `ok`（读到合法服务器列表；列表为空 = 真的没配 MCP 服务器）；
   * - `probe_failed`（serve 不可达 / HTTP 非 2xx / 非法 JSON / 响应不是 v2 形状）。
   *
   * ⚠️ 探测失败时 `entries` 是**上次成功的结果**（不是空数组）：控制面据此不会把
   * 「探针坏了」误读成「这个 worker 没有接 MCP」。
   */
  async getSnapshot(): Promise<McpStatusSnapshot> {
    const now = Date.now();
    if (now - this.lastProbeAt < this.throttleMs) {
      return this.cachedSnapshot;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.lastProbeAt = now;
    this.inFlight = this.probeOnce();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** 单次探测（HTTP + 解析）。 */
  private async probeOnce(): Promise<McpStatusSnapshot> {
    let payload: unknown;
    try {
      payload = await this.probeFn();
    } catch (err) {
      return this.fail(`探测异常: ${(err as Error).message}`);
    }
    if (!isMcpStatusPayload(payload)) {
      return this.fail('响应不是 v2 的 /api/mcp 形状（既不是数组，也没有 data 数组）');
    }
    const parsed = parseMcpStatusPayload(payload);
    if (parsed.unknownStatuses.length > 0) {
      const detail = parsed.unknownStatuses
        .map((u) => `${u.serverName}=${u.rawStatus || '(缺失)'}`)
        .join(', ');
      this.logger?.warn?.(
        `[mcp-status] 发现未知 MCP 状态（上游契约漂移？）：${detail} → 保守按 ${UNKNOWN_STATUS_FALLBACK} 上报（不静默丢弃该服务器）`,
      );
    }
    if (parsed.unnamedCount > 0) {
      this.logger?.warn?.(
        `[mcp-status] ${parsed.unnamedCount} 条 MCP 条目缺少名字（线契约要求 serverName 非空）→ 未上报`,
      );
    }
    this.cached = parsed.entries;
    this.cachedSnapshot = { entries: parsed.entries, outcome: 'ok' };
    this.warnBuiltinUnreachable(parsed.entries);
    return this.cachedSnapshot;
  }

  /**
   * 当前 MCP 状态条目（**仅条目**，心跳载荷用）。
   *
   * ⚠️ 心跳载荷的形状由 server DTO 固定（`status` 认 connected / failed / needs_auth /
   * **pending / disabled**——两端同步扩到五态），所以「探针失败」**不能**塞进条目里；
   * 失败结论走 `getSnapshot().outcome` + worker 日志。
   */
  async getStatus(): Promise<McpStatusEntry[]> {
    return (await this.getSnapshot()).entries;
  }
}
