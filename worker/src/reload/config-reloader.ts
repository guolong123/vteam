/**
 * opencode v2 的**配置热重载**（不重启 serve 进程）。
 *
 * ── 为什么不再「改配置 → 重启 serve」──────────────────────────────────────
 * v2 提供了两条可用的热重载手段（**真二进制实测**，opencode v2.0.28，隔离 HOME/XDG）：
 *
 * | 手段 | 手段 | 效果 |
 * |---|---|---|
 * | 文件监听（**默认开启**） | 改 `<workDir>/opencode.json` / `.opencode/skills/**` / `.opencode/plugins/**` / 隔离全局 `opencode.json` | 秒级自动生效，**serve PID 不变**、会话不断 |
 * | 显式原语 | `POST /api/location/reload` → **204** | **立刻**重建所有 location（确定性），serve PID 不变、会话存活 |
 *
 * 重启 serve 的代价有三条：① 随机端口场景下端口漂移 ⇒ 必须重新注册
 * `capabilities.baseUrl/port`（失败 = 静默断线）；② 有活跃会话时必须**等会话排空**
 * （无上界）；③ 重启窗口内 serve 不可用。⇒ 配置类变更一律走热重载。
 *
 * ⚠️ **重载会取消待答复项**（实测）：`POST /api/location/reload` 会
 * **取消所有 location 的 pending 表单与权限请求**（用户正在回答的问题会被静默销毁）。
 * ⇒ 本模块在重载前**必须**过 pending 闸门；有 pending ⇒ **不重载**
 * （改走文件监听路径——它不取消任何东西），并把这个事实**明确记进日志**。
 *
 * ⚠️ **口令从哪来**：密码**只从 serve 对象读**（`effectiveServerPassword`），
 * **绝不**另从环境变量读一份——否则会和 serve 的真实配置漂移（v2 恒开 Basic Auth，
 * 密码错了全线 401）。与 `mcp-status-probe.ts` 同一套做法。
 */

import {
  PendingRequestSnapshot,
  emptyPendingSnapshot,
} from './pending-requests';

/** serve 端点（baseUrl + Basic Auth 密码；密码为空 = 不鉴权）。 */
export interface ServeEndpoint {
  baseUrl: string;
  password: string | null;
}

/**
 * 热重载结局。
 *
 * - `reloaded`：`location/reload` 成功（且——若给了校验器——效果已被确认）；
 * - `deferred`：**有 pending 表单/权限（或结论不完整）** ⇒ 跳过确定性重载，
 *   改由文件监听路径生效（不取消任何待答复项）；
 * - `failed`：`location/reload` 本身失败（网络错 / 非 204）；
 * - `unverified`：重载返回成功，但**效果没被确认** ⇒ 调用方应回退到真实重启
 *   （静默失败 = worker 声称的配置 serve 从未加载）。
 */
export type ConfigReloadOutcome = 'reloaded' | 'deferred' | 'failed' | 'unverified';

/** 热重载结果（含可读原因，供日志与调用方决策）。 */
export interface ConfigReloadResult {
  outcome: ConfigReloadOutcome;
  detail: string;
  /** pending 快照（`deferred` 时有值：说明为什么不敢重载）。 */
  pending?: PendingRequestSnapshot;
}

/** 效果确认结果。 */
export interface ConfigVerification {
  ok: boolean;
  detail: string;
}

/** 效果确认器（可注入；不注入 = 不做确认）。 */
export type ConfigVerifier = () => Promise<ConfigVerification>;

/** 最小日志接口（duck typing，默认 console）。 */
export interface ConfigReloadLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ConfigReloaderOptions {
  /**
   * serve 端点提供器（**每次调用时读取**——serve 重启可能换端口，届时自动跟上）。
   * 必须注入 serve 的**实际配置**（baseUrl + effectiveServerPassword）。
   */
  endpoint: () => ServeEndpoint | undefined;
  /**
   * pending 检测（**逐会话**，与 location 无关；见 pending-requests.ts 的说明）。
   * 未注入 = 视为「无 pending」（仅在拿不到检测能力时使用；调用方应尽量注入）。
   */
  pendingProbe?: () => Promise<PendingRequestSnapshot>;
  /** fetch 注入点（单测；默认全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时 ms（默认 10_000；重载要等所有 location 重建完成，比普通读慢）。 */
  timeoutMs?: number;
  /** 日志（可选，默认 console）。 */
  logger?: ConfigReloadLogger;
}

/** 默认超时（重载端点要等所有 location 的替换构建落定，比普通读慢）。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 重载端点（v2 契约：`location.reload` → 204）。 */
export const LOCATION_RELOAD_PATH = '/api/location/reload';

/** Basic Auth 头（username 恒为 `opencode`，与 serve 的约定一致）。 */
export function buildServeAuthHeader(password: string | null | undefined): string | undefined {
  if (!password) {
    return undefined;
  }
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

/** 一次 serve 请求的结果。 */
export interface ServeResponse {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
}

/**
 * 打一次**带鉴权**的 serve 请求（读端点用）。
 *
 * ⚠️ 不复用环境变量里的密码：口令只从 serve 对象取（见文件头注释）。
 */
export async function requestServe(
  endpoint: ServeEndpoint | undefined,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ServeResponse> {
  if (!endpoint || !endpoint.baseUrl) {
    throw new Error('serve 端点未就绪（baseUrl 为空）');
  }
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}${path}`;
  const headers: Record<string, string> = {};
  const auth = buildServeAuthHeader(endpoint.password);
  if (auth) {
    headers.Authorization = auth;
  }
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/** v2 的列表响应（`{location, data:[...]}`；裸数组也容忍——防御性）。 */
export function unwrapServeList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload !== null && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data;
    }
  }
  return [];
}

/** 效果确认的公共选项。 */
export interface VerificationOptions {
  fetchImpl?: typeof fetch;
  /** 单次请求超时 ms。 */
  timeoutMs?: number;
  /**
   * 效果确认的**稳定窗口** ms（默认 2000）。
   *
   * 为什么需要：`POST /api/location/reload` 返回 204 时，location 的**替换构建已经
   * 发起但未必落定**——实测（opencode v2.0.28）新 provider 在 204 之后约 **100ms**
   * 才出现在 `GET /api/provider`。单次读会读到旧快照 ⇒ 误判「未生效」⇒ 误触发真重启。
   * ⇒ 在这个**有界**窗口内重试（不是长轮询：最多 2s，约 10 次读）。
   */
  settleMs?: number;
}

/** 默认稳定窗口（实测延迟 ~100ms；留足余量但仍是秒级有界）。 */
const DEFAULT_SETTLE_MS = 2000;
/** 稳定窗口内的重试间隔 ms。 */
const SETTLE_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在**有界**窗口内重试直到判定通过（或超时）。
 *
 * ⚠️ 不是长轮询：窗口默认 2s，最多约 10 次读；配置变更不该变成一个长任务。
 */
async function settle<T>(
  attempt: () => Promise<T>,
  isOk: (value: T) => boolean,
  settleMs: number,
): Promise<T> {
  const deadline = Date.now() + Math.max(0, settleMs);
  let last = await attempt();
  while (!isOk(last) && Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    last = await attempt();
  }
  return last;
}

/**
 * 确认某些 provider id 已在 serve 侧可见（`GET /api/provider`）。
 *
 * 用于「模型凭据注入」的效果确认：**凭据写进了文件不等于 serve 加载了它**。
 */
export async function verifyProvidersVisible(
  endpoint: ServeEndpoint | undefined,
  providerIDs: string[],
  options: VerificationOptions = {},
): Promise<ConfigVerification> {
  const ids = providerIDs.map((id) => id.trim()).filter((id) => id !== '');
  if (ids.length === 0) {
    return { ok: true, detail: '无 provider 需要确认（跳过效果校验）' };
  }
  const attempt = async (): Promise<ConfigVerification> => {
    let res: ServeResponse;
    try {
      res = await requestServe(endpoint, '/api/provider', options);
    } catch (err) {
      return { ok: false, detail: `GET /api/provider 失败: ${(err as Error).message}` };
    }
    if (!res.ok) {
      return { ok: false, detail: `GET /api/provider HTTP ${res.status}` };
    }
    const visible = new Set<string>();
    for (const item of unwrapServeList(res.json)) {
      if (item !== null && typeof item === 'object') {
        const id = (item as { id?: unknown }).id;
        if (typeof id === 'string') {
          visible.add(id);
        }
      }
    }
    const missing = ids.filter((id) => !visible.has(id));
    if (missing.length > 0) {
      return { ok: false, detail: `serve 侧未见 provider: ${missing.join(', ')}` };
    }
    return { ok: true, detail: `serve 侧可见 provider: ${ids.join(', ')}` };
  };
  const result = await settle(
    attempt,
    (value) => value.ok,
    options.settleMs ?? DEFAULT_SETTLE_MS,
  );
  return result;
}

/** 确认某些 MCP server 名已在 serve 侧可见（`GET /api/mcp`）。 */
export async function verifyMcpServersVisible(
  endpoint: ServeEndpoint | undefined,
  names: string[],
  options: VerificationOptions = {},
): Promise<ConfigVerification> {
  const ids = names.map((n) => n.trim()).filter((n) => n !== '');
  if (ids.length === 0) {
    return { ok: true, detail: '无 MCP server 需要确认（跳过效果校验）' };
  }
  const attempt = async (): Promise<ConfigVerification> => {
    let res: ServeResponse;
    try {
      res = await requestServe(endpoint, '/api/mcp', options);
    } catch (err) {
      return { ok: false, detail: `GET /api/mcp 失败: ${(err as Error).message}` };
    }
    if (!res.ok) {
      return { ok: false, detail: `GET /api/mcp HTTP ${res.status}` };
    }
    const visible = new Set<string>();
    for (const item of unwrapServeList(res.json)) {
      if (item !== null && typeof item === 'object') {
        const name = (item as { name?: unknown }).name;
        if (typeof name === 'string') {
          visible.add(name);
        }
      }
    }
    const missing = ids.filter((id) => !visible.has(id));
    if (missing.length > 0) {
      return { ok: false, detail: `serve 侧未见 MCP server: ${missing.join(', ')}` };
    }
    return { ok: true, detail: `serve 侧可见 MCP server: ${ids.join(', ')}` };
  };
  const result = await settle(
    attempt,
    (value) => value.ok,
    options.settleMs ?? DEFAULT_SETTLE_MS,
  );
  return result;
}

/** 确认某些 skill 名已在 serve 侧可见（`GET /api/skill`）。 */
export async function verifySkillsVisible(
  endpoint: ServeEndpoint | undefined,
  names: string[],
  options: VerificationOptions = {},
): Promise<ConfigVerification> {
  const ids = names.map((n) => n.trim()).filter((n) => n !== '');
  if (ids.length === 0) {
    return { ok: true, detail: '无 skill 需要确认（跳过效果校验）' };
  }
  const attempt = async (): Promise<ConfigVerification> => {
    let res: ServeResponse;
    try {
      res = await requestServe(endpoint, '/api/skill', options);
    } catch (err) {
      return { ok: false, detail: `GET /api/skill 失败: ${(err as Error).message}` };
    }
    if (!res.ok) {
      return { ok: false, detail: `GET /api/skill HTTP ${res.status}` };
    }
    const visible = new Set<string>();
    for (const item of unwrapServeList(res.json)) {
      if (item !== null && typeof item === 'object') {
        const id = (item as { id?: unknown }).id;
        const name = (item as { name?: unknown }).name;
        if (typeof id === 'string') {
          visible.add(id);
        }
        if (typeof name === 'string') {
          visible.add(name);
        }
      }
    }
    const missing = ids.filter((id) => !visible.has(id));
    if (missing.length > 0) {
      return { ok: false, detail: `serve 侧未见 skill: ${missing.join(', ')}` };
    }
    return { ok: true, detail: `serve 侧可见 skill: ${ids.join(', ')}` };
  };
  const result = await settle(
    attempt,
    (value) => value.ok,
    options.settleMs ?? DEFAULT_SETTLE_MS,
  );
  return result;
}

/**
 * 组合多个效果确认器（全部通过才算通过；任一失败即失败，detail 合并）。
 */
export function combineVerifiers(
  verifiers: Array<(() => Promise<ConfigVerification>) | undefined>,
): ConfigVerifier | undefined {
  const list = verifiers.filter((v): v is () => Promise<ConfigVerification> => Boolean(v));
  if (list.length === 0) {
    return undefined;
  }
  return async () => {
    const details: string[] = [];
    for (const verify of list) {
      let result: ConfigVerification;
      try {
        result = await verify();
      } catch (err) {
        result = { ok: false, detail: `效果校验异常: ${(err as Error).message}` };
      }
      details.push(result.detail);
      if (!result.ok) {
        return { ok: false, detail: details.join('；') };
      }
    }
    return { ok: true, detail: details.join('；') };
  };
}

/**
 * 配置热重载器：把「已落盘的配置」推到 serve 上生效，**不动 serve 进程**。
 *
 * 决策链（**顺序即语义**）：
 * 1. 端点未就绪 → `failed`（调用方回退真实重启）；
 * 2. **pending 闸门**：有 pending 表单/权限，或结论不完整 → `deferred`
 *    （**不重载**：改走文件监听路径；日志必须说明为什么延后）；
 * 3. `POST /api/location/reload` 非 204 → `failed`；
 * 4. 给了校验器且校验失败 → `unverified`（调用方回退真实重启）；
 * 5. 否则 → `reloaded`。
 */
export class ConfigReloader {
  private readonly options: ConfigReloaderOptions;
  private readonly logger: ConfigReloadLogger;

  constructor(options: ConfigReloaderOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
  }

  /**
   * 触发一次确定性热重载（`POST /api/location/reload`）。
   *
   * @param reason 人类可读的原因（进日志）。
   * @param verify 效果确认器（可选）：确认「新配置真的被 serve 加载了」。
   */
  async reload(reason: string, verify?: ConfigVerifier): Promise<ConfigReloadResult> {
    const endpoint = this.options.endpoint();
    if (!endpoint || !endpoint.baseUrl) {
      const detail = 'serve 端点未就绪（baseUrl 为空）';
      this.logger.warn(`[config-reload] ${reason}：${detail}`);
      return { outcome: 'failed', detail };
    }

    // ① pending 闸门（先于任何写操作）：有 pending ⇒ 不重载。
    const pending = await this.probePending();
    if (pending.forms > 0 || pending.permissions > 0 || pending.incomplete) {
      const detail =
        `存在待答复项（forms=${pending.forms}, permissions=${pending.permissions}` +
        `${pending.incomplete ? '，且检测结论不完整' : ''}` +
        `${pending.sessions.length > 0 ? `，sessions=${pending.sessions.join(',')}` : ''}）` +
        '：location/reload 会取消它们';
      this.logger.warn(
        `[config-reload] ${reason}：${detail} ⇒ 跳过确定性热重载，` +
          '改由 opencode v2 的文件监听路径生效（不取消任何待答复项）',
      );
      return { outcome: 'deferred', detail, pending };
    }

    // ② 显式重载原语。
    let res: ServeResponse;
    try {
      res = await requestServe(endpoint, LOCATION_RELOAD_PATH, {
        method: 'POST',
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (err) {
      const detail = `POST ${LOCATION_RELOAD_PATH} 失败: ${(err as Error).message}`;
      this.logger.warn(`[config-reload] ${reason}：${detail}`);
      return { outcome: 'failed', detail };
    }
    if (res.status !== 204) {
      const detail = `POST ${LOCATION_RELOAD_PATH} HTTP ${res.status}`;
      this.logger.warn(`[config-reload] ${reason}：${detail}`);
      return { outcome: 'failed', detail };
    }

    // ③ 效果确认（可选）：确认失败 ⇒ 未生效（调用方回退真实重启）。
    if (verify) {
      let verification: ConfigVerification;
      try {
        verification = await verify();
      } catch (err) {
        verification = { ok: false, detail: `效果校验异常: ${(err as Error).message}` };
      }
      if (!verification.ok) {
        const detail = `重载已返回 204，但效果未确认（${verification.detail}）`;
        this.logger.warn(`[config-reload] ${reason}：${detail}`);
        return { outcome: 'unverified', detail };
      }
      this.logger.info(`[config-reload] ${reason}：热重载完成（${verification.detail}）`);
      return { outcome: 'reloaded', detail: verification.detail };
    }

    this.logger.info(`[config-reload] ${reason}：热重载完成（POST ${LOCATION_RELOAD_PATH} → 204）`);
    return { outcome: 'reloaded', detail: `POST ${LOCATION_RELOAD_PATH} → 204` };
  }

  /** pending 探测（未注入 / 抛错 ⇒ 结论不完整 ⇒ 保守不重载）。 */
  private async probePending(): Promise<PendingRequestSnapshot> {
    if (!this.options.pendingProbe) {
      return emptyPendingSnapshot();
    }
    try {
      const snapshot = await this.options.pendingProbe();
      return snapshot ?? emptyPendingSnapshot();
    } catch (err) {
      this.logger.warn(
        `[config-reload] pending 检测失败（按「可能有待答复项」处理，不做确定性重载）: ${(err as Error).message}`,
      );
      return { forms: 0, permissions: 0, sessions: [], incomplete: true };
    }
  }
}
