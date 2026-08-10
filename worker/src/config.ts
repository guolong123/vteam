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
  /** opencode serve 工作目录（T5：.opencode/tools/ 注入落点）；默认 /tmp/keta-worker */
  workDir: string;
  /** SSH 私钥路径（T5 git 凭证注入：GIT_SSH_KEY_PATH，D6 2B）；可选，空 = 不注入 GIT_SSH_COMMAND */
  gitSshKeyPath: string;
  /** worker 对 server 公布的 serve 基址主机（D2：capabilities.baseUrl 上报用；容器 compose 设 http://worker） */
  workerAdvertiseHost: string;
  /** opencode serve 绑定地址（D2：默认 127.0.0.1 保住本地铁律；容器内设 0.0.0.0 供 server 容器访问） */
  opencodeServeHostname: string;
  /** C2：worker 默认模型（env WORKER_DEFAULT_MODEL，id 格式 providerID/modelID）；未设 = 不指定（serve 默认） */
  defaultModelId?: string;
  /**
   * T10：执行端点端口（env WORKER_EXEC_PORT，node:http POST /execute，与 serve 端口解耦）。
   * 随注册 capabilities.execPort 上报，server 据此发现执行端点；默认 4198。
   */
  workerExecPort: number;
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

  return {
    workerToken,
    serverUrl: (env.SERVER_URL ?? '').trim() || 'http://localhost:3000',
    workerId,
    workerName,
    opencodeServePort: parseNonNegativeInt('OPENCODE_SERVE_PORT', env.OPENCODE_SERVE_PORT, 0),
    serverPassword: (env.OPENCODE_SERVER_PASSWORD ?? '').trim(),
    heartbeatIntervalMs: parseNonNegativeInt('HEARTBEAT_INTERVAL_MS', env.HEARTBEAT_INTERVAL_MS, 10000),
    logLevel: (env.LOG_LEVEL ?? '').trim() || 'info',
    workDir: (env.WORK_DIR ?? '').trim() || '/tmp/keta-worker',
    gitSshKeyPath: (env.GIT_SSH_KEY_PATH ?? '').trim(),
    workerAdvertiseHost: (env.WORKER_ADVERTISE_HOST ?? '').trim() || 'http://127.0.0.1',
    opencodeServeHostname: (env.OPENCODE_SERVE_HOSTNAME ?? '').trim() || '127.0.0.1',
    defaultModelId: (env.WORKER_DEFAULT_MODEL ?? '').trim() || undefined,
    workerExecPort: parseNonNegativeInt('WORKER_EXEC_PORT', env.WORKER_EXEC_PORT, 4198),
  };
}
