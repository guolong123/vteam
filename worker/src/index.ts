/**
 * worker 独立入口（T2 最小骨架 + T3 serve 挂载 + T4 V1Driver 暴露 + T6 注册/心跳/事件通道）。
 *
 * 职责：加载配置 → 打印启动信息（workerId / serverUrl / opencode 版本探测）→
 * 启动 OpencodeServer（spawn opencode serve，T3）→ 创建 V1Driver（T4，封装 serve
 * REST API，serve 就绪后注入 baseUrl，供 T6/T10 会话执行）→ 注册（T6：X-Worker-Token，
 * 失败指数退避重试，仍失败即退出）→ 按 server 返回的 heartbeatIntervalMs 定时心跳
 * （顺带上报 serve 健康）→ SIGTERM/SIGINT 优雅退出（先停心跳 → flush 待发事件 →
 * stop serve 进程组 → exit）。
 *
 * ⚠️ 本文件刻意不含：git 凭证注入（T5 由 T3 serve 注入点承接）、
 * 事件内容语义（T9 server 侧消费）；事件上送通道（EventSender）已就绪供会话上报。
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, WorkerConfig } from './config';
import { EventSender } from './client/event-client';
import {
  RegisterResponse,
  registerWorkerWithRetry,
  sendHeartbeat,
  RegistryClientOptions,
} from './client/registry-client';
import { V1Driver, DriverModelInfo } from './driver/v1-driver';
import { GIT_TOOLS, installGitTools } from './git/git-tools';
import {
  GitCredentialEntry,
  GIT_CREDS_FILE,
  GitCredsResult,
  buildGitCredsFile,
  isValidGitCredEntry,
  writeGitCredsFile,
} from './git/git-credential-injector';
import { getLoad, onActiveSessionsIdle } from './instance-tracker';
import { McpStatusProbe } from './mcp-status/mcp-status-probe';
import {
  GitCredentialsPayload,
  ModelCredentialsPayload,
  WorkerCapabilities,
  WorkerCommand,
  WorkerCommandType,
  WorkerHealth,
  WorkerLoad,
  WORKER_COMMAND_TYPES,
} from './protocol/worker-protocol';
import { OpencodeServer } from './runtime/opencode-server';
import { ExecServer } from './exec/exec-server';
import { InjectReport, ResourceInjector } from './resources/injector';
import {
  RestartCoordinator,
  RestartDecision,
} from './restart/restart-coordinator';
import {
  AuthJsonResult,
  buildAuthJson,
  cleanupAuthJson,
  ModelCredentialEntry,
  writeAuthJson,
} from './credentials/model-credential-injector';

/** 无注入时的空报告（buildCapabilities/buildRegisterOptions 默认值；main() 总会传入真实报告）。 */
const EMPTY_INJECT_REPORT: InjectReport = { skills: [], tools: [], mcpServers: [] };

/** 探测 opencode CLI 版本（T3 前仅用于启动信息展示；失败不阻断启动）。 */
export function detectOpencodeVersion(): string {
  try {
    const result = spawnSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const version = (result.stdout ?? '').trim() || (result.stderr ?? '').trim();
    return version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** T4b 注入执行器通过 onCommands 注册的命令处理回调（处理心跳携带的下行命令）。 */
export type CommandHandler = (commands: WorkerCommand[]) => void | Promise<void>;

let commandHandler: CommandHandler | null = null;

/**
 * T4a：注册命令处理回调（T4b 注入执行器挂载点）。
 * 未注册时命令仅打日志占位（本任务范围），T4b 接线注入/重启执行。
 */
export function onCommands(handler: CommandHandler): void {
  commandHandler = handler;
}

/** T4a：命令分派——reload-config/model-credentials 打入口日志 + 透传注册回调（T4b 注入 + T4c 重启执行）。 */
export function dispatchCommands(commands: WorkerCommand[]): void {
  if (!commands || commands.length === 0) {
    return;
  }
  for (const command of commands) {
    if (command.type === WORKER_COMMAND_TYPES.RELOAD_CONFIG) {
      console.log(
        `[worker] 收到命令 reload-config（resourceVersion=${command.resourceVersion}），分派注入+重启`,
      );
    }
    if (command.type === WORKER_COMMAND_TYPES.MODEL_CREDENTIALS) {
      // C5：只打 providerID 清单（token 绝不进日志，安全基线）
      const modelPayload = command.payload as ModelCredentialsPayload | undefined;
      const providerIDs =
        modelPayload?.providerKeys?.map((k) => k.providerID).join(', ') ?? '';
      console.log(
        `[worker] 收到命令 model-credentials（providerKeys=[${providerIDs}]），分派 auth.json 注入+重启`,
      );
    }
    if (command.type === WORKER_COMMAND_TYPES.GIT_CREDENTIALS) {
      // 只打 repoUrl 清单（key 明文绝不进日志，安全基线）
      const gitPayload = command.payload as GitCredentialsPayload | undefined;
      const repoUrls =
        gitPayload?.credentials?.map((c) => c.repoUrl).join(', ') ?? '';
      console.log(
        `[worker] 收到命令 git-credentials（repoUrls=[${repoUrls}]），分派凭证文件写入`,
      );
    }
    if (command.type === WORKER_COMMAND_TYPES.RESTART) {
      console.log(
        `[worker] 收到命令 restart（resourceVersion=${command.resourceVersion}），分派远程重启`,
      );
    }
    if (command.type === WORKER_COMMAND_TYPES.SHUTDOWN) {
      console.log(
        `[worker] 收到命令 shutdown（resourceVersion=${command.resourceVersion}），分派优雅退出`,
      );
    }
  }
  void commandHandler?.(commands);
}

/** handleModelCredentials 的依赖注入面（单测可 mock 文件 IO 与重启协调）。 */
export interface ModelCredentialsHandlingDeps {
  /** 读取 auth.json 现有内容（不存在/读取失败 → null）。 */
  readContent: (authJsonPath: string) => Promise<string | null>;
  writeAuthJson: (providerKeys: ModelCredentialEntry[]) => AuthJsonResult;
  cleanupAuthJson: (authJsonPath: string) => void;
  requestRestart: (reason: string) => Promise<RestartDecision>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

/** 兜底读取路径：opencode 1.18.16 固定读 $HOME/.local/share/opencode/auth.json。 */
export const DEFAULT_AUTH_JSON_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'opencode',
  'auth.json',
);

/**
 * F3 防循环：model-credentials 命令幂等注入。
 * 用 buildAuthJson 生成新内容与现有 auth.json 内容对比（不重复实现序列化逻辑）：
 * - 相同 → 跳过写盘 + 不重启 serve（server 无条件回放场景下切断
 *   “重启 → reRegister → 回放 → 心跳 → 再重启”无限循环）
 * - 不同/缺失 → cleanup 旧文件 → 写新 auth.json → 重启 serve（凭据变更/容器重启后恢复）
 * 返回 { changed, authJsonPath }（authJsonPath 供调用方后续 cleanup）。
 */
export async function handleModelCredentials(
  providerKeys: ModelCredentialEntry[],
  injectedAuthJsonPath: string | null,
  deps: ModelCredentialsHandlingDeps,
): Promise<{ changed: boolean; authJsonPath: string }> {
  // 处理前读取现有 auth.json 内容：优先已记录注入路径，兜底默认路径（容器重启后
  // injectedAuthJsonPath 为 null，但 auth.json 可能仍在默认路径 → 靠内容对比判幂等）。
  const existingPath = injectedAuthJsonPath ?? DEFAULT_AUTH_JSON_PATH;
  const existingContent = await deps.readContent(existingPath);
  // 生成新内容（不落盘先对比）
  const newContent = buildAuthJson(providerKeys);
  if (existingContent === newContent) {
    deps.log('[worker] model-credentials：凭据未变化，跳过注入与重启');
    return { changed: false, authJsonPath: existingPath };
  }
  // 内容变化/缺失：保留现有逻辑——清理上一次注入的 auth.json → 写新 → 重启 serve
  if (injectedAuthJsonPath) {
    deps.cleanupAuthJson(injectedAuthJsonPath);
  }
  const injected = deps.writeAuthJson(providerKeys);
  deps.log(
    `[worker] model-credentials：auth.json 已注入 ${injected.authJsonPath}（providerKeys=${providerKeys.length}），重启 serve 生效`,
  );
  const decision = await deps.requestRestart('model-credentials（凭据注入）');
  if (decision === 'pending') {
    deps.log('[worker] model-credentials：存在活跃会话，重启挂起（会话归零后自动执行）');
  }
  return { changed: true, authJsonPath: injected.authJsonPath };
}

/** handleGitCredentials 的依赖注入面（单测可 mock 文件 IO）。 */
export interface GitCredentialsHandlingDeps {
  /** 读取凭证文件现有内容（不存在/读取失败 → null）。 */
  readContent: (filePath: string) => Promise<string | null>;
  /** 写凭证文件（600 权限落盘，仿 writeGitCredsFile）。 */
  writeContent: (entries: GitCredentialEntry[]) => GitCredsResult;
  log: (message: string) => void;
  warn: (message: string) => void;
}

/** 从现有文件内容提取 updatedAt（解析失败/缺失 → undefined，幂等对比复用）。 */
function extractUpdatedAt(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { updatedAt?: unknown };
    return typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * git-credentials 命令幂等落盘。与 model-credentials 的关键区别：**不重启 serve**
 * （git 工具每次执行读文件取凭证，写盘即生效）。逻辑：读现有文件内容 → 复用其
 * updatedAt 重建新内容（credentials 一致 → 输出完全一致）→ 一致则跳过写盘（幂等，
 * mtime 不变）；否则写盘（内容变化/缺失）。返回 { changed, path }。
 */
export async function handleGitCredentials(
  entries: GitCredentialEntry[],
  deps: GitCredentialsHandlingDeps,
): Promise<{ changed: boolean; path: string }> {
  const existingPath = GIT_CREDS_FILE;
  if (!Array.isArray(entries)) {
    deps.warn('[worker] git-credentials：credentials 负载缺失，跳过写入');
    return { changed: false, path: existingPath };
  }
  const existingContent = await deps.readContent(existingPath);
  const newContent = buildGitCredsFile(
    entries,
    existingContent ? extractUpdatedAt(existingContent) : undefined,
  );
  if (existingContent === newContent) {
    deps.log('[worker] git-credentials：凭证文件未变化，跳过写入');
    return { changed: false, path: existingPath };
  }
  const validCount = entries.filter(isValidGitCredEntry).length;
  if (validCount === 0 && entries.length > 0) {
    deps.warn('[worker] git-credentials：条目全部无效（空 repoUrl/key 已过滤）');
  }
  const result = deps.writeContent(entries);
  deps.log(`[worker] git-credentials：凭证文件已更新（${validCount} 条）`);
  return { changed: true, path: result.path };
}

function printStartup(config: WorkerConfig, opencodeVersion: string): void {
  console.log(`[worker] 启动中:
  workerId            = ${config.workerId}
  workerName          = ${config.workerName}
  serverUrl           = ${config.serverUrl}
  opencodeServePort   = ${config.opencodeServePort === 0 ? '0（OS 随机空闲端口）' : config.opencodeServePort}
  opencodeServeAuth   = ${config.serverPassword ? 'Basic Auth（已设 OPENCODE_SERVER_PASSWORD）' : '无（serve 不设鉴权）'}
  opencodeServeHost   = ${config.opencodeServeHostname}
  workerAdvertiseHost = ${config.workerAdvertiseHost}
  heartbeatIntervalMs = ${config.heartbeatIntervalMs}
  workerMaxInstances  = ${config.workerMaxInstances}
  logLevel            = ${config.logLevel}
  opencodeVersion     = ${opencodeVersion}`);
}

/** C2 模型探测重试选项（B2：空列表重试参数，options.delay 供单测注入跳过真实等待）。 */
export interface ModelListProbeOptions {
  /** 空列表额外重试次数（默认 3 次，延迟 1s/2s/4s 指数退避，总窗口 ~7s）。 */
  retries?: number;
  /** 首次重试延迟基数 ms（默认 1000；第 n 次重试延迟 = base * 2^n）。 */
  retryDelayMs?: number;
  /** 可注入 sleep（单测传 0ms 跳过真实等待；缺省 setTimeout）。 */
  delay?: (ms: number) => Promise<void>;
  /** C3 稳定性确认：同一非空列表需连续出现 stability 次才上报（默认 1=首次非空即上报，兼容旧行为）。 */
  stability?: number;
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** C3 稳定性辅助：两批模型 id 是否一致（顺序无关）。 */
function sameModelIds(a: string[], b: string[] | null): boolean {
  if (!b || a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * C2：探测 serve 真实模型列表并映射为上报格式（id 字符串列表，格式 providerID/modelID，
 * 对齐 C1 目录 id 拆解约定）。
 * B2 修复（F3）：serve 就绪瞬间 /api/model 可能返回空列表（serve 模型表仍在预热，F3 实测
 * ~3s 后才返回完整模型）——空列表不再视为"已探测无模型"，而是"未就绪"：按 1s/2s/4s 指数
 * 退避重试直到非空或重试耗尽。
 * C3 修复（CONF-01）：预热期 /api/model 除空列表外还可能返回中间态假模型列表（实测 25 个
 * 假模型），稳定性校验（options.stability > 1）要求同一列表连续 N 次探测一致才上报，
 * 不一致时重置计数继续探测，耗尽仍不稳定 → 降级 undefined（宁可不带 models 也不上报假列表）。
 * - 非空且通过稳定性确认 → 返回 id 数组（正常上报）
 * - 重试耗尽仍空/不稳定 → 降级 undefined（不携带 models，不阻断注册）
 * - listModels 抛错（serve 未就绪/端点不支持/网络错）→ 立即降级 undefined
 * 独立导出便于单测 mock driver.listModels 的空/非空/抛错三态。
 */
export async function resolveModels(
  lister: { listModels(): Promise<DriverModelInfo[]> },
  options: ModelListProbeOptions = {},
): Promise<string[] | undefined> {
  const {
    retries = 3,
    retryDelayMs = 1000,
    delay = defaultDelay,
    stability = 1,
  } = options;

  let lastIds: string[] | null = null;
  let stableCount = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let raw: DriverModelInfo[];
    try {
      raw = await lister.listModels();
    } catch (err) {
      console.warn(`[worker] 模型列表探测失败（注册降级不带 models，不阻断注册）: ${(err as Error).message}`);
      return undefined;
    }

    if (raw.length > 0) {
      const ids = raw.map((m) => m.id);
      if (stability <= 1) {
        return ids;
      }
      if (sameModelIds(ids, lastIds)) {
        stableCount++;
      } else {
        stableCount = 1;
        lastIds = ids;
      }
      if (stableCount >= stability) {
        return ids;
      }
    } else {
      lastIds = null;
      stableCount = 0;
    }

    if (attempt < retries) {
      const backoffMs = retryDelayMs * 2 ** attempt;
      console.warn(
        `[worker] 模型列表探测未稳定（第 ${attempt + 1}/${retries + 1} 次，serve 可能仍在预热），${backoffMs}ms 后重试`,
      );
      await delay(backoffMs);
    }
  }
  console.warn(`[worker] 模型列表探测 ${retries + 1} 次仍未获得稳定列表，注册降级不带 models（不阻断注册）`);
  return undefined;
}

/**
 * T6：注册能力声明（T10 细化并发上限/技能清单；当前单实例 + 已注入的 git 工具族）。
 * F2 C2：serve 实际监听端口必须随注册上报——随机端口（OPENCODE_SERVE_PORT=0）场景下
 * server 侧 WorkerClient.resolveBaseUrl 读 capabilities.port，缺失会回退死端口 4199。
 * D2：另上报 capabilities.baseUrl = ${advertiseHost}:${port}（容器内 compose 设
 * WORKER_ADVERTISE_HOST=http://worker，server resolveBaseUrl 优先读 baseUrl 直连）。
 * T9：接入注入器清单——skills 上报注入器实际注入的 skill 名，tools 合并内置 git 工具族
 * 与注入的自定义工具（去重）。
 * C2：models 为 serve 真实模型 id 列表（resolveModels 结果）；undefined（探测失败）不携带。
 * T10：execPort 为执行端点端口（config.workerExecPort；端点启动失败时传 undefined 不上报，
 * server 不会连到不可用端点）。
 * F4：maxInstances 并发上限配置化——由调用方传入 config.workerMaxInstances（env
 * WORKER_MAX_INSTANCES，默认 5），替代原硬编码 1（单实例导致长任务执行期间新消息
 * 全部被拒"无可用 worker"）；serve 实测支持多 session 并行。
 * 异步化语义：与调用点（serve 就绪后）保持一致，供 registerCurrent/reRegister 链 await。
 */
export async function buildCapabilities(
  port: number | null,
  advertiseHost: string,
  injected: InjectReport = EMPTY_INJECT_REPORT,
  models?: string[],
  execPort?: number,
  maxInstances = 5,
): Promise<WorkerCapabilities> {
  const base = advertiseHost.replace(/\/+$/, '');
  const tools = [...new Set([...GIT_TOOLS.map((tool) => tool.name), ...injected.tools])];
  return {
    maxInstances,
    skills: injected.skills,
    tools,
    port: port ?? undefined,
    baseUrl: port !== null ? `${base}:${port}` : undefined,
    ...(models !== undefined ? { models } : {}),
    ...(execPort !== undefined ? { execPort } : {}),
  };
}

/**
 * T4c/T6：组装注册选项。T4c 重启后 serve 端口可能变化（随机端口），reRegister 用当前
 * serveServer.port 重新组装 → capabilities.baseUrl/port 随心跳后注册更新，server 才能连上新端口。
 * T9：injected 为最近一次注入报告（启动注入 + reload-config 重注入后更新），
 * 注册/reRegister 携带真实 skills/tools 清单，保证 worker 详情页数据非陈旧。
 * C2：models 透传 buildCapabilities（resolveModels 结果，失败 undefined 不带）；
 * defaultModelId 来自 config.defaultModelId（env WORKER_DEFAULT_MODEL），未配置不携带。
 */
export async function buildRegisterOptions(
  config: WorkerConfig,
  port: number | null,
  serveVersion: string,
  cliVersion: string,
  injected: InjectReport = EMPTY_INJECT_REPORT,
  models?: string[],
  execPort?: number,
): Promise<RegistryClientOptions> {
  const capabilities = await buildCapabilities(
    port,
    config.workerAdvertiseHost,
    injected,
    models,
    execPort,
    config.workerMaxInstances,
  );
  return {
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    workerId: config.workerId,
    workerName: config.workerName,
    opencodeVersion: serveVersion !== 'unknown' ? serveVersion : cliVersion,
    capabilities,
    ...(config.defaultModelId ? { defaultModelId: config.defaultModelId } : {}),
    ...(config.mcpUrl ? { mcpUrl: config.mcpUrl } : {}),
  };
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  const opencodeVersion = detectOpencodeVersion();

  printStartup(config, opencodeVersion);

  // K3 修复（T6）：serve 启动前把 git 工具族注入工作目录（<workDir>/.opencode/tools/git.ts，
  // opencode 启动时扫描该目录自动注册；注入失败不阻断启动，工具缺失由后续执行时报错暴露）。
  try {
    const gitToolsPath = installGitTools(config.workDir);
    console.log(`[worker] git 工具族已注入: ${gitToolsPath}`);
  } catch (err) {
    console.error(`[worker] git 工具族注入失败: ${(err as Error).message}`);
  }

  // T3：拉起 opencode serve（spawn detached + 健康检查；失败即退出）。
  // T6（K3）：cwd 必须对齐 workDir——serve 以 cwd 为工作区扫描 .opencode/tools/，
  // 与 installGitTools 注入落点一致，否则注入的工具永远不会被加载。
  const serveServer = new OpencodeServer({
    port: config.opencodeServePort,
    serverPassword: config.serverPassword,
    cwd: config.workDir,
  });

  // T4：V1Driver（封装 serve REST API）；serve 随机端口启动成功后在 .then 注入 baseUrl。
  // 会话执行链路（createSession 驱动 → 事件上送）待 T10 回流接线；实例计数挂钩点见
  // v1-driver.ts createSession 注释（F2 M4）。
  const driver = new V1Driver({
    serverPassword: config.serverPassword,
  });

  // T4b：资源注入执行器——serve 启动前拉取控制面 skills/tools/mcp-servers 注入
  // <workDir>（.opencode/skills/ + .opencode/tools/ + opencode.json mcp 节），
  // 心跳命令 reload-config 回调复用同一注入器重拉（T4c 重启后生效）。
  const injector = new ResourceInjector({
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    workerId: config.workerId,
    workDir: config.workDir,
  });

  // T6/T4c：注册状态（初始注册成功/重启后重注册共享更新；心跳定时器读取 workerId 与间隔）。
  let registeredWorkerId = '';
  let heartbeatIntervalMs = config.heartbeatIntervalMs;

  // T9：最近一次注入报告（启动注入 + reload-config 重注入后更新）。
  // 注册/reRegister 据此上报真实 skills/tools 清单——reload-config 后 reRegister 复用，
  // 资源变更后 worker 详情页数据非陈旧。
  let lastInjectReport: InjectReport = EMPTY_INJECT_REPORT;

  // T6 注册（X-Worker-Token）：失败指数退避重试（1s/2s/4s/8s...封顶 30s），
  // 重试耗尽返回 null（由调用方决定退出或降级）。
  // C2：serve 就绪后先探测真实模型列表（resolveModels 失败降级 undefined，不带 models 不阻断注册）。
  // C3（CONF-01）：stability=2——预热期中间态假模型列表需连续 2 次探测一致才上报，杜绝假模型回流。
  const registerCurrent = async (): Promise<RegisterResponse | null> => {
    const models = await resolveModels(driver, { stability: 2 });
    return registerWorkerWithRetry(
      await buildRegisterOptions(
        config,
        serveServer.port,
        serveServer.version,
        opencodeVersion,
        lastInjectReport,
        models,
        execPort,
      ),
      { logger: { warn: (message: string) => console.warn(`[worker] ${message}`) } },
    ).catch((err: Error) => {
      console.error(`[worker] 注册失败（重试耗尽）: ${err.message}`);
      return null;
    });
  };

  // T4c：重启后重新注册——serve 随机端口重启后可能变化，用当前 port 重新组装注册选项；
  // 失败不退出（serve 已在新端口运行，server 连旧端口报 degraded，再次 reload-config 可修复）。
  const reRegister = async (): Promise<void> => {
    const result = await registerCurrent();
    if (result === null) {
      console.warn(
        '[worker] 重启后重新注册失败：serve 已在新端口运行，server 可能连不上（可再次触发 reload-config 修复）',
      );
      return;
    }
    registeredWorkerId = result.workerId;
    heartbeatIntervalMs = result.heartbeatIntervalMs;
    console.log(`[worker] 重启后重新注册成功: workerId=${result.workerId}`);
  };

  // T4c：重启协调器——无活跃会话才重启（单 serve 实例，重启会中断会话）；
  // 有活跃会话则挂起，等会话归零后自动执行。
  const restartCoordinator = new RestartCoordinator({
    activeSessionCount: () => getLoad().instances,
    // B1 配套：serve 重启（随机端口可能变化）后须同步 driver.baseUrl——否则
    // reRegister 的 resolveModels 探测打到旧端口 fetch failed，capabilities.models 恒空。
    restart: async () => {
      const baseUrl = await serveServer.restart();
      driver.baseUrl = baseUrl;
      return baseUrl;
    },
    reRegister,
    logger: {
      info: (message: string) => console.log(`[worker] ${message}`),
      warn: (message: string) => console.warn(`[worker] ${message}`),
      error: (message: string) => console.error(`[worker] ${message}`),
    },
  });

  // T4b：注册命令处理回调（T4a 挂载点）——reload-config 触发资源重拉 + 注入 +
  // T4c 重启判定（无活跃会话立即重启 serve 使新配置生效，有活跃会话则挂起）。
  // C5b：记录上一次注入的 auth.json 路径（下次写入前 cleanup，不留存旧凭据明文）。
  let injectedAuthJsonPath: string | null = null;
  onCommands(async (commands) => {
    for (const command of commands) {
      if (command.type === WORKER_COMMAND_TYPES.RELOAD_CONFIG) {
        try {
          const report = await injector.injectAll();
          // T9：重注入后更新注入清单，重启后的 reRegister 上报最新 skills/tools
          lastInjectReport = report;
          console.log(
            `[worker] reload-config：资源重注入完成（${report.skills.length} skills, ${report.tools.length} tools, ${report.mcpServers.length} mcp servers）`,
          );
          const decision = await restartCoordinator.requestRestart(
            `reload-config（resourceVersion=${command.resourceVersion}）`,
          );
          if (decision === 'pending') {
            console.log('[worker] reload-config：存在活跃会话，重启挂起（会话归零后自动执行）');
          }
        } catch (err) {
          console.warn(`[worker] reload-config 资源重注入失败: ${(err as Error).message}`);
        }
      }
      if (command.type === WORKER_COMMAND_TYPES.MODEL_CREDENTIALS) {
        const payload = command.payload as ModelCredentialsPayload | undefined;
        if (!payload?.providerKeys) {
          console.warn('[worker] model-credentials 命令缺少 providerKeys 负载，跳过注入');
          continue;
        }
        try {
          // F3 防循环：内容幂等注入——auth.json 内容未变化时跳过写盘与重启 serve，
          // 切断“server 无条件回放 → 重启 → reRegister → 回放 → 再重启”无限循环。
          injectedAuthJsonPath = (
            await handleModelCredentials(
              payload.providerKeys,
              injectedAuthJsonPath,
              {
                readContent: async (authJsonPath) => {
                  try {
                    return await fs.promises.readFile(authJsonPath, 'utf8');
                  } catch {
                    return null;
                  }
                },
                writeAuthJson,
                cleanupAuthJson,
                requestRestart: (reason) =>
                  restartCoordinator.requestRestart(reason),
                log: (message) => console.log(message),
                warn: (message) => console.warn(message),
              },
            )
          ).authJsonPath;
        } catch (err) {
          console.warn(`[worker] model-credentials 注入失败: ${(err as Error).message}`);
        }
      }
      if (command.type === WORKER_COMMAND_TYPES.GIT_CREDENTIALS) {
        const payload = command.payload as GitCredentialsPayload | undefined;
        if (!payload?.credentials) {
          console.warn('[worker] git-credentials 命令缺少 credentials 负载，跳过写入');
          continue;
        }
        try {
          // 与 model-credentials 关键区别：写盘即生效（git 工具每次执行读文件），不重启 serve。
          await handleGitCredentials(payload.credentials, {
            readContent: async (filePath) => {
              try {
                return await fs.promises.readFile(filePath, 'utf8');
              } catch {
                return null;
              }
            },
            writeContent: (entries) => writeGitCredsFile(entries),
            log: (message) => console.log(message),
            warn: (message) => console.warn(message),
          });
        } catch (err) {
          console.warn(`[worker] git-credentials 注入失败: ${(err as Error).message}`);
        }
      }
      if (command.type === WORKER_COMMAND_TYPES.RESTART) {
        // UX-01：管理员远程重启——复用 T4c 重启协调器（无活跃会话立即重启 serve +
        // reRegister 更新 baseUrl/port，有活跃会话挂起等归零）。
        const decision = await restartCoordinator.requestRestart(
          `远程重启（resourceVersion=${command.resourceVersion}）`,
        );
        if (decision === 'pending') {
          console.log('[worker] restart 命令：存在活跃会话，重启挂起（会话归零后自动执行）');
        }
      }
      if (command.type === WORKER_COMMAND_TYPES.SHUTDOWN) {
        // UX-01：管理员远程下线——复用优雅退出流程（停心跳 + flush 事件 + stop
        // serve + exit）；进程退出后心跳停止，server 30s 健康检查维持 offline。
        console.log('[worker] shutdown 命令：优雅退出中（停心跳 + flush 事件 + stop serve）');
        shutdown('remote-shutdown');
      }
    }
  });

  // T4c：活跃会话归零时检查挂起的重启（T10 会话执行接入 trackInstanceStart/End 后自动触发）
  onActiveSessionsIdle(() => restartCoordinator.checkPending());

  // T8c：MCP 三态探测器（30s 节流——不能每 10s 心跳 spawn 子进程，Metis 高优补项 7）。
  // 心跳回调携带 getStatus() 快照（节流窗口内复用缓存），首次探测失败为空数组不阻断心跳。
  const mcpStatusProbe = new McpStatusProbe({
    // cwd 对齐 workDir：opencode mcp list 基于 cwd 查找 opencode.json（注入配置落点）
    cwd: config.workDir,
    logger: {
      warn: (message: string) => console.warn(`[worker] ${message}`),
    },
  });

  // T6：事件上送通道（进程内单例，seq 从 1 起单调递增 + F2 M1 bootId 区分重启）。
  // 事件产生（session.updated/task.completed 等）待 T10 回流接线（C1 并行任务）。
  const eventSender = new EventSender({
    serverUrl: config.serverUrl,
    workerId: config.workerId,
    workerToken: config.workerToken,
  });

  // T10：执行端点——独立 HTTP server（node:http，POST /execute，固定端口
  // WORKER_EXEC_PORT 默认 4198），与 serve 端口解耦；随注册 capabilities.execPort
  // 上报，server 据此发现执行端点下发 prompt（方案 A：worker 主动推）。
  const execServer = new ExecServer({
    port: config.workerExecPort,
    driver,
    sender: eventSender,
    workerToken: config.workerToken,
    firstTokenTimeoutMs: config.workerFirstTokenTimeoutMs,
    // T17：serve 日志模型错误检测数据源——awaitCompletion 每轮轮询读 recentErrors()，
    // 命中模型 API 错误关键词（Rate limit/Free usage 等只写 stderr 不透传
    // message.info.error）时提前 abort + 抛错（错误文本透传前端，不再空等首字超时）
    serveErrorReader: () => serveServer.recentErrors(),
  });
  // T10：执行端点上报端口（start 成功 = 实际监听端口；失败置 undefined，注册不带 execPort）
  let execPort: number | undefined = config.workerExecPort;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // 优雅退出：SIGTERM/SIGINT 统一收口，防重复处理；
  // 先停心跳 → flush 待发事件 → stop serve 进程组再 exit。
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[worker] 收到 ${signal}，正在退出...`);
    void (async () => {
      try {
        stopHeartbeat();
        await eventSender.flush();
        await execServer.stop();
        if (serveServer.isRunning) {
          await serveServer.stop();
        }
        // C5b：worker 退出时清理注入的 auth.json（明文 key 不留存，幂等；
        // 只删 auth.json 文件，不删 $HOME/.local/share/opencode 目录——内含 opencode.db）
        if (injectedAuthJsonPath) {
          cleanupAuthJson(injectedAuthJsonPath);
        }
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // T4b：启动链——先注入平台资源（serve 启动前落盘，opencode 启动时才能扫描到），
  // 再拉起 serve；注入失败不阻断启动（后续心跳 reload-config 命令可重拉修复）。
  void (async () => {
    try {
      const report = await injector.injectAll();
      // T9：首次注入清单作为注册时上报的真实 skills/tools
      lastInjectReport = report;
      console.log(
        `[worker] 平台资源注入完成: ${report.skills.length} skills, ${report.tools.length} tools, ${report.mcpServers.length} mcp servers`,
      );
    } catch (err) {
      console.warn(
        `[worker] 平台资源注入失败（继续启动 serve，心跳命令可重拉）: ${(err as Error).message}`,
      );
    }

    try {
      const baseUrl = await serveServer.start();
      // T4：serve 就绪后注入实际 baseUrl（随机端口场景，driver 后续请求才有目标地址）
      driver.baseUrl = baseUrl;
      console.log(`[worker] opencode serve 就绪: ${baseUrl} (pid=${serveServer.pid})`);

      // T10：执行端点启动（node:http POST /execute，固定端口）。失败仅记录日志并
      // 置 execPort=undefined（注册不带 execPort，server 不会连到不可用端点），
      // 不阻断 serve/注册/心跳主链。
      try {
        const bound = await execServer.start();
        execPort = bound;
        console.log(`[worker] 执行端点就绪: POST http://127.0.0.1:${bound}/execute`);
      } catch (err) {
        execPort = undefined;
        console.warn(
          `[worker] 执行端点启动失败（capabilities 不报 execPort）: ${(err as Error).message}`,
        );
      }

      // T6 注册（X-Worker-Token）：失败指数退避重试（1s/2s/4s/8s...封顶 30s），
      // 重试耗尽仍失败 → 清理 serve 进程组并退出（无法成为可用 worker）。
      const registerResult = await registerCurrent();

      if (registerResult === null) {
        if (serveServer.isRunning) {
          await serveServer.stop();
        }
        process.exit(1);
      }
      registeredWorkerId = registerResult.workerId;
      heartbeatIntervalMs = registerResult.heartbeatIntervalMs;

      console.log(
        `[worker] 注册成功: workerId=${registerResult.workerId}, heartbeatInterval=${registerResult.heartbeatIntervalMs}ms, serverTime=${registerResult.serverTime}`,
      );

      // 心跳：间隔以 server 返回为准（T7 协议 heartbeatIntervalMs），
      // 顺带上报 serve 健康（isRunning → ok，否则 degraded）。
      heartbeatTimer = setInterval(() => {
        void (async () => {
          // F2 M4：load 上报真实活动会话数（instance-tracker 计数，
          // T10 会话执行接线后由 V1Driver 调用点 trackInstanceStart/End 驱动）
          const load: WorkerLoad = getLoad();
          const health: WorkerHealth = serveServer.isRunning ? 'ok' : 'degraded';
          try {
            const heartbeat = await sendHeartbeat({
              serverUrl: config.serverUrl,
              workerToken: config.workerToken,
              workerId: registeredWorkerId,
              load,
              health,
              // T8c：MCP 三态快照（节流缓存，30s 内复用）
              mcpStatus: mcpStatusProbe.getStatus(),
            });
            // T4a：心跳响应携带的下行命令 → 分派处理（reload-config 注入+重启）
            dispatchCommands(heartbeat.commands ?? []);
          } catch (err) {
            console.warn(`[worker] 心跳失败: ${(err as Error).message}`);
          }
        })();
      }, heartbeatIntervalMs);
    } catch (err) {
      console.error(`[worker] opencode serve 启动失败: ${(err as Error).message}`);
      process.exit(1);
    }
  })();

  // 心跳定时器保持事件循环存活（serve 为 detached 子进程，不维持父进程事件循环）。
  console.log(`[worker] 就绪（pid=${process.pid}）。`);
}

// require.main 守卫：作为入口（node dist/index.js / tsx src/index.ts）才启动 worker；
// 被 import（如 index.spec.ts 测 buildCapabilities）时不触发 main()。
if (require.main === module) {
  main();
}
