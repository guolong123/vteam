/**
 * worker 环境配置（T2 运行时骨架）。
 *
 * 全部从 process.env 读取并带默认值；X_WORKER_TOKEN 必填（缺失即抛错）。
 * 后续 T3-T6 统一通过 loadConfig() 返回的 WorkerConfig 访问，避免散落读 env。
 * 与 server 约定：SERVER_URL 默认 http://localhost:3000（nest 默认端口）。
 */

import * as os from 'os';

export interface WorkerConfig {
  /** 注册鉴权 token（对齐协议 X-Worker-Token header，D1）；必填 */
  workerToken: string;
  /** server 基址；默认 http://localhost:3000（nest 默认端口） */
  serverUrl: string;
  /** worker 唯一 id；默认 w_<hostname>（对齐协议 RegisterWorkerPayload.workerId 前缀） */
  workerId: string;
  /** worker 可读名称（注册时可选展示）；默认取 hostname */
  workerName: string;
  /** opencode serve 端口；0 = 随机端口（D2 端口冲突重试策略的随机起点，T3 由 OS 分配空闲端口） */
  opencodeServePort: number;
  /** opencode serve 认证密码（OPENCODE_SERVER_PASSWORD，Basic Auth username=opencode，D2）；空 = 不设鉴权 */
  serverPassword: string;
  /** 心跳间隔 ms；默认 10000（D1：10s 心跳，server 30s=3 周期判 offline） */
  heartbeatIntervalMs: number;
  /** 日志级别；默认 info */
  logLevel: string;
  /** opencode serve 工作目录（T5：.opencode/tools/ 注入落点）；默认 /tmp/vteam-worker */
  workDir: string;
  /** SSH 私钥路径（T5 git 凭证注入：GIT_SSH_KEY_PATH，D6 2B）；可选，空 = 不注入 GIT_SSH_COMMAND */
  gitSshKeyPath: string;
  /** worker 对 server 公布的 serve 基址主机（D2：capabilities.baseUrl 上报用；容器 compose 设 http://worker） */
  workerAdvertiseHost: string;
  /** WORKER_ADVERTISE_HOST 是否显式设置（env 中非空值即 true）。未显式设置时上报 baseUrl 为
   *  http://127.0.0.1（仅本机可访问）——外部/跨机 worker 场景需启动告警引导（见 index.ts）。 */
  workerAdvertiseHostExplicit: boolean;
  /** opencode serve 绑定地址（D2：默认 127.0.0.1 保住本地铁律；容器内设 0.0.0.0 供 server 容器访问） */
  opencodeServeHostname: string;
  /** C2：worker 默认模型（env WORKER_DEFAULT_MODEL，id 格式 providerID/modelID）；未设 = 不指定（serve 默认） */
  defaultModelId?: string;
  /**
   * 内置 vteam MCP 地址覆盖（env WORKER_MCP_URL，可选）。
   * 默认取 server 下发的 mcp_servers.url（seed 的 PLATFORM_MCP_URL）——K8s 内为
   * 集群服务名（http://vteam-server:3000/api/v1/platform-mcp），集群外 worker 无法
   * 解析。注册时上报本值（capabilities.mcpUrl），server 在 worker 拉取 mcp-servers
   * 时按 worker 覆盖内置地址下发。未设置 = 用全局地址。
   */
  mcpUrl?: string;
  /**
   * T10：执行端点端口（env WORKER_EXEC_PORT，node:http POST /execute，与 serve 端口解耦）。
   * 随注册 capabilities.execPort 上报，server 据此发现执行端点；默认 4198。
   */
  workerExecPort: number;
  /**
   * T10：执行端点首字超时 ms（env WORKER_FIRST_TOKEN_TIMEOUT_MS，awaitCompletion
   * 首字超时——时限内模型无输出即 abort）；默认 120000。首字出现后无完成超时。
   */
  workerFirstTokenTimeoutMs: number;
  /**
   * worker 最大并发会话数（env WORKER_MAX_INSTANCES，随注册 capabilities.maxInstances
   * 上报，server 容量调度 capacity = maxInstances - load.instances 据此分派）。
   * 默认 5——serve 实测支持多 session 并行；长任务（模型思考/限流重试）执行中
   * 仍可调度新消息。配置为 ≤0 等非法值兜底默认值。
   */
  workerMaxInstances: number;
}

/**
 * 自动探测本机非回环网卡 IPv4，作为 WORKER_ADVERTISE_HOST 缺省来源（用户未显式设置时
 * 用探测到的内网 IP 上报，替代固定回退 http://127.0.0.1——后者仅本机可访问，跨机 worker
 * server 连不上）。
 * 遍历 os.networkInterfaces()：按返回顺序取第一个非 internal 的 IPv4 地址；跳过虚拟网卡
 * （docker/veth/br-/vnic/virbr/cni/flannel 等桥接/容器网络，非 server 可达的真实网卡）。
 * 返回裸 IP 字符串（如 "192.168.1.10"）；无命中（全回环/无网卡/仅 IPv6）返回 undefined。
 * 纯函数（仅依赖 os 内置模块），独立导出便于单测 mock。
 */
export function detectLocalIPv4(): string | undefined {
  const VIRTUAL_PREFIXES = ['docker', 'veth', 'br-', 'vnic', 'virbr', 'cni', 'flannel'];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    if (VIRTUAL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    for (const net of interfaces[name] ?? []) {
      if (!net.internal && net.family === 'IPv4') {
        return net.address;
      }
    }
  }
  return undefined;
}

/** 解析非负整数配置项；缺省/空串回落默认值，非法值抛错。 */
function parseNonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`[config] ${name} 必须是非负整数，收到: "${raw}"`);
  }
  return value;
}

/**
 * 解析正整数配置项（必须 ≥ 1）；缺省/空串回落默认值。
 * 非法值（NaN/非整数/≤0）不抛错，兜底默认值并打 warn——并发上限误配成 ≤0/NaN 会
 * 回归单实例行为，兜底比抛错更利于运维自愈；区别于 parseNonNegativeInt 的抛错语义。
 */
function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    console.warn(`[config] ${name} 非法值 "${raw}"（须为 ≥1 的整数），回落默认 ${fallback}`);
    return fallback;
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const workerToken = (env.X_WORKER_TOKEN ?? '').trim();
  if (!workerToken) {
    throw new Error(
      '[config] 缺少必填环境变量 X_WORKER_TOKEN（注册鉴权 token，对齐 X-Worker-Token header，见 .env.example）',
    );
  }

  const hostname = os.hostname();
  const workerId = (env.WORKER_ID ?? '').trim() || `w_${hostname}`;
  const workerName = (env.WORKER_NAME ?? '').trim() || hostname;
  const advertiseHostRaw = (env.WORKER_ADVERTISE_HOST ?? '').trim();
  // 未显式设置时自动探测本机非回环 IPv4 作为上报基址（detectLocalIPv4 失败/无命中回退
  // http://127.0.0.1——仅本机可访问，跨机 worker 场景由启动告警引导显式设置）。
  const detectedIPv4 = advertiseHostRaw ? undefined : detectLocalIPv4();

  return {
    workerToken,
    serverUrl: (env.SERVER_URL ?? '').trim() || 'http://localhost:3000',
    workerId,
    workerName,
    opencodeServePort: parseNonNegativeInt('OPENCODE_SERVE_PORT', env.OPENCODE_SERVE_PORT, 0),
    serverPassword: (env.OPENCODE_SERVER_PASSWORD ?? '').trim(),
    heartbeatIntervalMs: parseNonNegativeInt('HEARTBEAT_INTERVAL_MS', env.HEARTBEAT_INTERVAL_MS, 10000),
    logLevel: (env.LOG_LEVEL ?? '').trim() || 'info',
    workDir: (env.WORK_DIR ?? '').trim() || '/tmp/vteam-worker',
    gitSshKeyPath: (env.GIT_SSH_KEY_PATH ?? '').trim(),
    workerAdvertiseHost: advertiseHostRaw || (detectedIPv4 ? `http://${detectedIPv4}` : 'http://127.0.0.1'),
    workerAdvertiseHostExplicit: advertiseHostRaw.length > 0,
    // opencodeServeHostname：OPENCODE_SERVE_HOSTNAME 显式设置时尊重用户；否则按 serve 必须
    // 可达性自适应——adverse 指向外部/非回环 IP（如 192.168.x）→ 必须 0.0.0.0（否则 serve
    // 只监听 127.0.0.1 时 server fetch baseUrl 失败），其他情况（本地开发/探测失败）保留
    // 127.0.0.1 铁律。
    opencodeServeHostname: (() => {
      const explicit = (env.OPENCODE_SERVE_HOSTNAME ?? '').trim();
      if (explicit) return explicit;
      // 解析 advertise host 提取 host 部分（去协议/端口）
      let host = '';
      try {
        const adv = advertiseHostRaw || (detectedIPv4 ? `http://${detectedIPv4}` : 'http://127.0.0.1');
        host = adv.replace(/^[a-zA-Z]+:\/\//, '').replace(/[:/].*$/, '');
      } catch {
        host = '127.0.0.1';
      }
      // host 是 127.0.0.1/::1/localhost 或空 → 本地开发，保持 127.0.0.1
      if (!host || host === '127.0.0.1' || host === '::1' || host === 'localhost') {
        return '127.0.0.1';
      }
      // 外部/集群外 host（192.168.x / 10.x / 公网 IP）→ 必须 0.0.0.0 让 serve 监听非回环
      return '0.0.0.0';
    })(),
    defaultModelId: (env.WORKER_DEFAULT_MODEL ?? '').trim() || undefined,
    mcpUrl: (env.WORKER_MCP_URL ?? '').trim() || undefined,
    workerExecPort: parseNonNegativeInt('WORKER_EXEC_PORT', env.WORKER_EXEC_PORT, 4198),
    workerFirstTokenTimeoutMs: parseNonNegativeInt(
      'WORKER_FIRST_TOKEN_TIMEOUT_MS',
      env.WORKER_FIRST_TOKEN_TIMEOUT_MS,
      120000,
    ),
    workerMaxInstances: parsePositiveInt('WORKER_MAX_INSTANCES', env.WORKER_MAX_INSTANCES, 5),
  };
}
