/**
 * worker 环境配置（T2 运行时骨架）。
 *
 * 全部从 process.env 读取并带默认值；X_WORKER_TOKEN 必填（缺失即抛错）。
 * 后续 T3-T6 统一通过 loadConfig() 返回的 WorkerConfig 访问，避免散落读 env。
 * 与 server 约定：SERVER_URL 默认 http://localhost:3000（nest 默认端口）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  /**
   * opencode serve 认证密码（OPENCODE_SERVER_PASSWORD，Basic Auth username=opencode，D2）。
   * ⚠️ v2 **恒开鉴权**：为空时 opencode 会自动生成随机密码并打到 stdout，worker 不解析它
   * 就会全线 401 → 默认 **fail-fast**（见 allowGeneratedPassword 的逃生开关）。
   */
  serverPassword: string;
  /**
   * 逃生开关（env OPENCODE_ALLOW_GENERATED_PASSWORD）：允许在**未配置**密码时，从 serve stdout
   * 的 `server password <pw>` 行捕获 opencode 自动生成的密码并采用。
   * 默认 false（v2 恒开鉴权 → 密码为空即 fail-fast，给出可操作错误）。
   */
  allowGeneratedPassword: boolean;
  /**
   * 驱动模式开关（env OPENCODE_V2_ENABLED）：**恒为 true**（T18 起单轨）。
   *
   * ⚠️ 显式 false（`OPENCODE_V2_ENABLED=false`）在 `loadConfig` 阶段**直接抛错**：
   * v1 驱动已随 v2 切换删除（计划 §9.3 的回滚保险用尽），留一个「看起来能切、实际切不了」
   * 的开关 = 故障时按错方向排查。唯一有效回退是回滚镜像/代码到 v1.0.x（并回滚数据卷）。
   */
  opencodeV2Enabled: boolean;
  /** 心跳间隔 ms；默认 10000（D1：10s 心跳，server 30s=3 周期判 offline） */
  heartbeatIntervalMs: number;
  /** 日志级别；默认 info */
  logLevel: string;
  /** opencode serve 工作目录（T5：.opencode/tools/ 注入落点）；默认 /data/vteam-worker */
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
   * 首字超时——时限内模型无输出即 abort）；缺省 0=禁用首字超时，长脚本/等权限不误杀，
   * env 可 opt-in（首字/模型探测唯一归 worker，server 侧为 SILENT_SESSION_WAKE_MS=600000
   * 滑动事件静默自愈，不抢跑）。首字出现后无完成超时。
   */
  workerFirstTokenTimeoutMs: number;
  /**
   * worker 最大并发会话数（env WORKER_MAX_INSTANCES，随注册 capabilities.maxInstances
   * 上报，server 容量调度 capacity = maxInstances - load.instances 据此分派）。
   * 默认 5——serve 实测支持多 session 并行；长任务（模型思考/限流重试）执行中
   * 仍可调度新消息。配置为 ≤0 等非法值兜底默认值。
   */
  workerMaxInstances: number;
  /**
   * worker 执行总时长上限 ms（env WORKER_TOTAL_TIMEOUT_MS，opt-in）。自 awaitCompletion
   * 开始计时，首字出现后到期限仍无完成（step-finish）→ abort + 抛「执行总时长超限」。
   * 默认 0 = 禁用（保持既有「首字后无完成超时」契约，判死由 server 空闲 watchdog 负责）。
   */
  workerTotalTimeoutMs: number;
  /**
   * 独立模式（env WORKER_STANDALONE）：true = 跳过控制面注册/心跳/资源拉取，
   * serve + 执行端点照常启动（无 SERVER_URL 可达也能起）。默认 false = 现行注册模式。
   */
  standalone: boolean;
  /**
   * opencode 隔离配置域（T16b）：serve 子进程的 HOME / XDG_* 全部指向它，
   * 宿主机的全局配置、全局插件、全局 AGENTS.md 不在作用域内。
   */
  isolationScope: OpencodeIsolationScope;
}

/* -------------------------------------------------------------------------- *
 * 隔离配置域（T16b：T6 结论「v2 没有 --pure 等价物」的落地）
 * -------------------------------------------------------------------------- */

/**
 * 隔离根目录的 env 名（运维可覆盖；缺省 = `<HOME>/.opencode-iso`）。
 *
 * 为什么需要它：opencode **v2 删掉了 `--pure`**（T6 实测 13 例矩阵），
 * `plugins: []` / `instructions: []` / `experimental` / `OPENCODE_CONFIG*` **全部无效**
 * （`plugins` 是跨配置**合并**语义、`instructions` 只能**追加**），
 * `OPENCODE_DISABLE_PROJECT_CONFIG=1` 会连**项目 `opencode.json`** 一起杀掉（vteam 不能用），
 * `plugins: ["-*"]` 会把内置 agent/provider 一起关掉（`Agent not found: "build"`）——
 * ⇒ **唯一可靠手段 = 隔离配置发现路径**：给 serve 一个自己的 `HOME` / `XDG_CONFIG_HOME`，
 * 宿主机的全局配置、全局插件、全局 `AGENTS.md` 全部不在作用域内。
 */
export const OPENCODE_ISOLATION_ROOT_ENV = 'OPENCODE_ISOLATION_ROOT';

/** 隔离根目录的默认目录名（挂在 worker 自己的 HOME 下）。 */
const ISOLATION_ROOT_DIR_NAME = '.opencode-iso';

/**
 * opencode 隔离配置域的目录布局（T16b）。
 *
 * 布局（全部在**同一个持久化卷**上）：
 * ```
 * <root>/                        隔离根（= <HOME>/.opencode-iso，落在 worker_home 卷上）
 *   home/                        子进程 HOME（**空目录** → 任何 $HOME 兜底路径都落在隔离域内）
 *   config/opencode/opencode.json  全局配置（provider 段）      ← XDG_CONFIG_HOME=<root>/config
 *   data/opencode/auth.json        模型凭据                      ← XDG_DATA_HOME=<root>/data
 *   data/opencode/opencode.db      v2 会话库（SQLite）            ← 同上
 *   data/opencode/log/opencode.log serve 诊断日志                ← 同上
 *   state/opencode/                状态                          ← XDG_STATE_HOME=<root>/state
 *   cache/opencode/                缓存                          ← XDG_CACHE_HOME=<root>/cache
 * ```
 *
 * ⚠️ **为什么落在 worker 的 HOME 下（而不是 workDir 下）**：
 * ① workDir 是 **opencode 的项目作用域**（serve cwd = workDir，vteam 的项目 `opencode.json`
 *    与 `.opencode/` 注入物都在那儿）——把"全局作用域"塞进项目作用域会让两层的边界变模糊；
 * ② worker 的 HOME **本来就是**部署里为 opencode 数据持久化预留的卷
 *    （compose：`worker_home:/root`，注释明写"opencode.db 会话库、auth.json 模型凭据、log"；
 *    chart：`HOME=/root` + `worker-home` PVC）——⇒ 隔离根默认落在这块已有持久化卷上，
 *    **部署侧零改动**，且与 v1 的旧数据（`<HOME>/.local/share/opencode/`）天然隔离
 *    （不复用 v1 数据卷，符合计划 T16b 的"回滚关系"）。
 */
export interface OpencodeIsolationScope {
  /** 隔离根目录（启动日志打印的就是它；不含任何密文） */
  root: string;
  /** 子进程 HOME（空目录 → 宿主的 ~/.config、~/.local/share 一律不在作用域内） */
  home: string;
  /** 子进程 XDG_CONFIG_HOME（全局配置 / 全局插件 / 全局 AGENTS.md 的作用域） */
  configHome: string;
  /** 子进程 XDG_DATA_HOME（auth.json / 会话库 / 日志） */
  dataHome: string;
  /** 子进程 XDG_STATE_HOME */
  stateHome: string;
  /** 子进程 XDG_CACHE_HOME */
  cacheHome: string;
  /** 全局 opencode 配置文件（provider 段的落点） */
  configFile: string;
  /** 模型凭据文件（auth.json 的落点） */
  authJsonFile: string;
  /** serve 诊断日志文件（次级错误源） */
  logFile: string;
  /** v2 会话库（SQLite；**绝不可删**——D11 铁律） */
  dbFile: string;
}

/**
 * 解析隔离配置域。
 *
 * - 根目录：`env.OPENCODE_ISOLATION_ROOT`（非空则用它）→ 缺省 `<HOME>/.opencode-iso`；
 * - `HOME` 取 `os.homedir()`（POSIX 下它本身就优先读 `$HOME`；用 os 而非 env 是为了让
 *   单测能 mock 住 home——`exec/local-config.ts` 也走同一套默认落点）。
 *
 * 纯函数（不碰文件系统），单测可直接断言布局。
 */
export function resolveIsolationScope(
  env: NodeJS.ProcessEnv = process.env,
): OpencodeIsolationScope {
  const rawRoot = (env[OPENCODE_ISOLATION_ROOT_ENV] ?? '').trim();
  const root =
    rawRoot !== '' ? path.resolve(rawRoot) : path.join(os.homedir(), ISOLATION_ROOT_DIR_NAME);
  const home = path.join(root, 'home');
  const configHome = path.join(root, 'config');
  const dataHome = path.join(root, 'data');
  const stateHome = path.join(root, 'state');
  const cacheHome = path.join(root, 'cache');
  return {
    root,
    home,
    configHome,
    dataHome,
    stateHome,
    cacheHome,
    configFile: path.join(configHome, 'opencode', 'opencode.json'),
    authJsonFile: path.join(dataHome, 'opencode', 'auth.json'),
    logFile: path.join(dataHome, 'opencode', 'log', 'opencode.log'),
    dbFile: path.join(dataHome, 'opencode', 'opencode.db'),
  };
}

/**
 * 物化隔离配置域的目录（mkdir -p 五个落点）。
 *
 * 为什么由 worker 显式建：serve 的 `HOME` / `XDG_*` 全部指向这里，空目录会让部分
 * 依赖 HOME 存在的路径解析失败；提前建好也让"隔离域落在哪个卷"在启动日志里一眼可见。
 * 失败**不阻断启动**（opencode 自己也会按需创建），只告警。
 *
 * @returns 实际创建的目录列表（失败时返回已成功的部分）。
 */
export function ensureIsolationScope(scope: OpencodeIsolationScope): string[] {
  const created: string[] = [];
  for (const dir of [
    scope.root,
    scope.home,
    scope.configHome,
    scope.dataHome,
    scope.stateHome,
    scope.cacheHome,
  ]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    } catch (err) {
      console.warn(
        `[config] 隔离配置域目录创建失败（忽略，serve 会自行按需创建）: ${dir} (${(err as Error).message})`,
      );
    }
  }
  return created;
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

function parseBool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(value)) {
    return false;
  }
  console.warn(`[config] ${name} 非法值 "${raw}"（须为 true/false/1/0/yes/no/on/off），回落默认 ${fallback}`);
  return fallback;
}

/**
 * 驱动模式开关解析（T18 起单轨）。
 *
 * 显式 false → **抛错**（响亮失败，绝不静默）：v1 驱动已随 v2 切换删除，
 * `OPENCODE_V2_ENABLED=false` 不再有第二个实现可选——静默继续跑只会让故障现场更难解释。
 * 错误文案直接指向真正的回退手段（回滚镜像/代码到 v1.0.x + 回滚数据卷）。
 */
function parseDriverModeSwitch(name: string, raw: string | undefined): boolean {
  const enabled = parseBool(name, raw, true);
  if (!enabled) {
    throw new Error(
      `[config] ${name}=false 已不再支持：v1 驱动已随 v2 切换移除（T18 单轨收口）；` +
        '回退请回滚镜像/代码到 v1.0.x（并一并回滚 opencode 数据卷——v2 启动时已就地迁移该卷）。',
    );
  }
  return enabled;
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
    allowGeneratedPassword: parseBool(
      'OPENCODE_ALLOW_GENERATED_PASSWORD',
      env.OPENCODE_ALLOW_GENERATED_PASSWORD,
      false,
    ),
    opencodeV2Enabled: parseDriverModeSwitch(
      'OPENCODE_V2_ENABLED',
      env.OPENCODE_V2_ENABLED,
    ),
    heartbeatIntervalMs: parseNonNegativeInt('HEARTBEAT_INTERVAL_MS', env.HEARTBEAT_INTERVAL_MS, 10000),
    logLevel: (env.LOG_LEVEL ?? '').trim() || 'info',
    workDir: (env.WORK_DIR ?? '').trim() || '/data/vteam-worker',
    gitSshKeyPath: (env.GIT_SSH_KEY_PATH ?? '').trim(),
    workerAdvertiseHost: advertiseHostRaw || (detectedIPv4 ? `http://${detectedIPv4}` : 'http://127.0.0.1'),
    workerAdvertiseHostExplicit: advertiseHostRaw.length > 0,
    opencodeServeHostname: (env.OPENCODE_SERVE_HOSTNAME ?? '').trim() || '127.0.0.1',
    defaultModelId: (env.WORKER_DEFAULT_MODEL ?? '').trim() || undefined,
    mcpUrl: (env.WORKER_MCP_URL ?? '').trim() || undefined,
    workerExecPort: parseNonNegativeInt('WORKER_EXEC_PORT', env.WORKER_EXEC_PORT, 4198),
    workerFirstTokenTimeoutMs: parseNonNegativeInt(
      'WORKER_FIRST_TOKEN_TIMEOUT_MS',
      env.WORKER_FIRST_TOKEN_TIMEOUT_MS,
      0,
    ),
    workerMaxInstances: parsePositiveInt('WORKER_MAX_INSTANCES', env.WORKER_MAX_INSTANCES, 5),
    workerTotalTimeoutMs: parseNonNegativeInt(
      'WORKER_TOTAL_TIMEOUT_MS',
      env.WORKER_TOTAL_TIMEOUT_MS,
      0,
    ),
    standalone: parseBool('WORKER_STANDALONE', env.WORKER_STANDALONE, false),
    isolationScope: resolveIsolationScope(env),
  };
}
