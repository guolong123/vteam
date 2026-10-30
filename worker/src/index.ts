/**
 * worker 独立入口（T2 最小骨架 + T3 serve 挂载 + T8 驱动接缝 + T6 注册/心跳/事件通道）。
 *
 * 职责：加载配置 → 打印启动信息（workerId / serverUrl / opencode 版本探测）→
 * 启动 OpencodeServer（spawn opencode serve，T3）→ 创建驱动（T8：经工厂构造，
 * T18 起**单轨**只有 v2 实现；只依赖 OpenCodeDriver 接缝；封装 serve REST API，
 * serve 就绪后注入 baseUrl，供 T6/T10 会话执行）→ 注册（T6：X-Worker-Token，
 * 失败指数退避重试，仍失败即退出）→ 按 server 返回的 heartbeatIntervalMs 定时心跳
 * （顺带上报 serve 健康）→ SIGTERM/SIGINT 优雅退出（先停心跳 → flush 待发事件 →
 * stop serve 进程组 → exit）。
 *
 * ⚠️ 本文件刻意不含：git 凭证注入（T5 由 T3 serve 注入点承接）、
 * 事件内容语义（T9 server 侧消费）；事件上送通道（EventSender）已就绪供会话上报。
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, WorkerConfig, OpencodeIsolationScope, ensureIsolationScope } from './config';
import { EventSender } from './client/event-client';
import {
  RegisterResponse,
  registerWorkerWithRetry,
  sendHeartbeat,
  RegistryClientOptions,
} from './client/registry-client';
import { createOpencodeDriver, resolveOpencodeDriverMode } from './driver';
import { unwrapV2List } from './driver/v2-driver';
import { SystemHandoffStore } from './driver/v2-system-handoff';
import { DriverModelInfo } from './driver/opencode-driver';
import { GIT_TOOLS, installGitTools } from './git/git-tools';
import { BROWSER_TOOLS, installBrowserTools, isAgentBrowserAvailable } from './browser/browser-tools';
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
  ModelProviderConfigEntry,
  SetMaxInstancesPayload,
  WorkerCapabilities,
  WorkerCommand,
  WorkerCommandType,
  WorkerHealth,
  WorkerLoad,
  WorkerUpdateState,
  WORKER_COMMAND_TYPES,
} from './protocol/worker-protocol';
import { OpencodeServer } from './runtime/opencode-server';
import {
  assertOpencodeVersionSupported,
  formatOpencodeVersion,
  normalizeOpencodeVersion,
  parseOpencodeVersion,
  OpencodeVersionInfo,
} from './runtime/opencode-version';
import { ExecServer } from './exec/exec-server';
import { InjectReport, ResourceInjector } from './resources/injector';
import { readOmoEnabled } from './resources/omo-enabled';
import { seedOmoAgentModels } from './resources/omo-config';
import { RestartCoordinator } from './restart/restart-coordinator';
import {
  ConfigReloadOutcome,
  ConfigReloader,
  ConfigVerification,
  combineVerifiers,
  verifyMcpServersVisible,
  verifyProvidersVisible,
  verifySkillsVisible,
} from './reload/config-reloader';
import { readUpdateCommandVersion, WorkerUpdater } from './update/worker-updater';
import { resolveCodeVersion } from './code-version';
import {
  AuthJsonResult,
  buildAuthJson,
  buildProviderSection,
  cleanupAuthJson,
  DEFAULT_AUTH_JSON_PATH as INJECTOR_DEFAULT_AUTH_JSON_PATH,
  DEFAULT_OPENCODE_CONFIG_PATH,
  mergeProviderSection,
  ModelCredentialEntry,
  writeAuthJson,
  writeOpencodeConfig,
} from './credentials/model-credential-injector';
import { syncIntegrationCredentials } from './credentials/integration-credential-sync';

/** 无注入时的空报告（buildCapabilities/buildRegisterOptions 默认值；main() 总会传入真实报告）。 */
const EMPTY_INJECT_REPORT: InjectReport = {
  skills: [],
  tools: [],
  mcpServers: [],
  agentPolicies: { enabled: false, names: [] },
};

/**
 * 构造资源注入器（**接线日志出口**）。
 *
 * ⚠️ 注入器自己的诊断（资源拉取失败、跳过原因、`/agent-policies` 中性化）**全部**走
 * 它的 `logger`；不接线 ⇒ 这些告警一条都不会打印 ⇒ 平台只看到「注入完成：0 tools」，
 * 分不清"平台本来就没有自定义工具"与"拉取炸了/注入被跳过"——这正是**静默失败**的典型形态。
 * 故本工厂是注入器的**唯一**构造入口。
 */
export function createResourceInjector(options: {
  serverUrl: string;
  workerToken: string;
  workerId: string;
  workDir: string;
  fetchImpl?: typeof fetch;
}): ResourceInjector {
  return new ResourceInjector({
    ...options,
    logger: {
      info: (message: string) => console.log(message),
      warn: (message: string) => console.warn(message),
    },
  });
}

/**
 * 构造事件上送客户端（**接线日志出口**）。
 *
 * ⚠️ `EventSender.deliver` 的契约是「重试耗尽 ⇒ **记日志不抛**」（事件可丢，靠 server 侧
 * 去重兜底）——不接线日志 ⇒ **事件丢失完全无声**，控制面收不到 `task.completed` /
 * 正文增量 / 工具 part，页面只显示"还在跑"。故本工厂是 EventSender 的**唯一**构造入口。
 */
export function createEventSender(options: {
  serverUrl: string;
  workerId: string;
  workerToken: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}): EventSender {
  return new EventSender({
    ...options,
    logger: {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    },
  });
}

/**
 * 注入报告里的「工具」口径渲染（**让 0 可解释**）。
 *
 * ⚠️ 控制面 `GET /tools` 返回的是**工具目录**（= 能力/权限点目录：opencode 原生工具 +
 * MCP 服务器的工具条目 + 平台自定义工具），而 worker 注入的是**自定义工具插件**
 * （落 `<workDir>/.opencode/plugins/<action>.ts`）——**两个数不是同一个类别**
 * （目录里的条目数 ≠ 插件数）。这里把两个数都报出来，读者才能分清：
 * - 「平台没有可注入的自定义工具」；
 * - 「拉取失败」（拉取失败会抛错并中止本轮注入，日志里是「注入失败」那条）；
 * - 「有工具定义但都不可注入」（缺执行细节 ⇒ 真实缺口，注入器另有逐条告警）。
 */
export function formatToolInjectionSummary(report: InjectReport): string {
  const injected = report.tools.length;
  const breakdown = report.toolBreakdown;
  if (!breakdown) {
    return `${injected} 个自定义工具插件`;
  }
  if (breakdown.fetched === 0) {
    return (
      `${injected} 个自定义工具插件（控制面工具目录 0 条：平台当前没有启用的工具定义；` +
      '这不是拉取失败——拉取失败会中止本轮注入并打印失败原因）'
    );
  }
  return (
    `${injected} 个自定义工具插件（控制面工具目录 ${breakdown.fetched} 条：` +
    `mcp 型 ${breakdown.mcpType} 条由 mcp 配置节承载、builtin ${breakdown.builtin} 条是 opencode 原生工具目录项，` +
    `均不渲染为插件；缺少执行细节 ${breakdown.missingExecution} 条未渲染）`
  );
}

/**
 * 探测 opencode CLI 版本（T1：与 `runtime/opencode-server.ts` 共用同一个解析器，
 * 避免两处对版本串格式的认知分叉）。
 *
 * 返回**原始**输出（`opencode v2.0.28` / `opencode 1.19.0` / `unknown`）。
 */
export function detectOpencodeVersionRaw(): string {
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

/**
 * 探测并解析 opencode CLI 版本（T1）。
 *
 * 返回规范化 semver 串（`2.0.28`）——**上报给控制面的唯一形态**：调度器按精确串相等
 * 过滤 worker（`workers.service.ts` 的 opencodeVersion 比较），格式必须两端一致。
 * 解析失败 → `'unknown'`（不抛错；控制面按串过滤会天然挡掉该 worker）。
 */
export function detectOpencodeVersion(): string {
  return formatOpencodeVersion(parseOpencodeVersion(detectOpencodeVersionRaw()));
}

/** 探测并解析 opencode CLI 版本（T1：启动期版本闸门用）。 */
export function detectOpencodeVersionInfo(): OpencodeVersionInfo {
  return parseOpencodeVersion(detectOpencodeVersionRaw());
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

/** T4a：命令分派——reload-config/model-credentials 打入口日志 + 透传注册回调（注入 + **热重载**，不重启 serve）。 */
export function dispatchCommands(commands: WorkerCommand[]): void {
  if (!commands || commands.length === 0) {
    return;
  }
  for (const command of commands) {
    if (command.type === WORKER_COMMAND_TYPES.RELOAD_CONFIG) {
      console.log(
        `[worker] 收到命令 reload-config（resourceVersion=${command.resourceVersion}），分派注入+热重载`,
      );
    }
    if (command.type === WORKER_COMMAND_TYPES.MODEL_CREDENTIALS) {
      // C5：只打 providerID 清单（token 绝不进日志，安全基线）；C6 附带
      // providerConfigs 的 providerID 清单（baseUrl 非密，便于排查配置未生效）。
      const modelPayload = command.payload as ModelCredentialsPayload | undefined;
      const providerIDs =
        modelPayload?.providerKeys?.map((k) => k.providerID).join(', ') ?? '';
      const cfgIDs =
        modelPayload?.providerConfigs !== undefined
          ? `，providerConfigs=[${Object.keys(modelPayload.providerConfigs).join(', ')}]`
          : '';
      console.log(
        `[worker] 收到命令 model-credentials（providerKeys=[${providerIDs}]${cfgIDs}），分派 auth.json/opencode.json 注入+热重载`,
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
    if (command.type === WORKER_COMMAND_TYPES.UPDATE_WORKER) {
      // 自更新目标版本：payload.version 优先，回落 resourceVersion（server 现网形态）。
      console.log(
        `[worker] 收到命令 update-worker（目标版本=${readUpdateCommandVersion(command) ?? '未携带'}），分派自更新执行器`,
      );
    }
    if (command.type === WORKER_COMMAND_TYPES.SET_MAX_INSTANCES) {
      console.log(
        `[worker] 收到命令 set-max-instances（resourceVersion=${command.resourceVersion}），分派动态并发上限更新`,
      );
    }
  }
  void commandHandler?.(commands);
}

/** 运行时配置文件名（workDir 下；set-max-instances 持久化落点，重启后本地优先 env）。 */
export const RUNTIME_CONFIG_FILE = '.worker-runtime-config.json';

/**
 * set-max-instances：解析启动时的有效并发上限（**本地文件 > env**）。
 * server 下发的动态上限持久化到 <workDir>/.worker-runtime-config.json；重启后本地文件
 * 仍生效（覆盖 WORKER_MAX_INSTANCES）。文件缺失（首次启动，静默）/损坏/值非法（非整数
 * 或 <1）→ 回落 env 值并 warn，绝不阻断启动。
 */
export function resolveRuntimeMaxInstances(workDir: string, envValue: number): number {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workDir, RUNTIME_CONFIG_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[worker] 读取运行时配置失败（忽略，回落 WORKER_MAX_INSTANCES=${envValue}）: ${(err as Error).message}`,
      );
    }
    return envValue;
  }
  try {
    const parsed = JSON.parse(raw) as { maxInstances?: unknown };
    const value = parsed?.maxInstances;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
      console.log(
        `[worker] 运行时配置生效：maxInstances=${value}（本地文件优先于 WORKER_MAX_INSTANCES=${envValue}）`,
      );
      return value;
    }
    console.warn(
      `[worker] 运行时配置 maxInstances 非法（忽略，回落 WORKER_MAX_INSTANCES=${envValue}）`,
    );
  } catch (err) {
    console.warn(
      `[worker] 运行时配置解析失败（忽略，回落 WORKER_MAX_INSTANCES=${envValue}）: ${(err as Error).message}`,
    );
  }
  return envValue;
}

/** set-max-instances：持久化有效并发上限到 <workDir>/.worker-runtime-config.json（mkdir -p + JSON 写）。 */
export function persistRuntimeMaxInstances(workDir: string, maxInstances: number): void {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, RUNTIME_CONFIG_FILE),
    JSON.stringify({ maxInstances }, null, 2),
    'utf8',
  );
}

/**
 * set-max-instances：校验负载（正整数）→ 更新内存有效值并本地持久化（持久化失败不影响
 * 内存生效）。返回新有效值（非法负载返回原值）；调用方据此更新 effectiveMaxInstances，
 * 下次注册/心跳起下发给 server，无需重启 serve。
 */
export function applySetMaxInstances(
  payload: SetMaxInstancesPayload | undefined,
  current: number,
  workDir: string,
  log: (message: string) => void = (message) => console.log(message),
): number {
  const value = payload?.maxInstances;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    log(`[worker] set-max-instances 负载非法（maxInstances=${String(value)}），忽略（保持 ${current}）`);
    return current;
  }
  try {
    persistRuntimeMaxInstances(workDir, value);
  } catch (err) {
    console.warn(`[worker] set-max-instances 持久化失败（内存值仍生效）: ${(err as Error).message}`);
  }
  log(`[worker] set-max-instances = ${value}（无需重启 serve）`);
  return value;
}

/** handleModelCredentials 的依赖注入面（单测可 mock 文件 IO 与重启协调）。 */
export interface ModelCredentialsHandlingDeps {
  /** 读取 auth.json 现有内容（不存在/读取失败 → null）。 */
  readContent: (authJsonPath: string) => Promise<string | null>;
  writeAuthJson: (providerKeys: ModelCredentialEntry[]) => AuthJsonResult;
  cleanupAuthJson: (authJsonPath: string) => void;
  /** 读取 opencode.json 现有内容（C6，不存在/读取失败 → null）。 */
  readConfig: (configPath: string) => Promise<string | null>;
  /** C6：写 opencode.json（provider 段合并，600；内容未变跳过写盘）。 */
  writeOpencodeConfig: (
    existingRaw: string | null,
    section: Record<string, unknown> | undefined,
  ) => { changed: boolean; path: string };
  /**
   * T16b：隔离配置域（凭据与 provider 配置的落点）。
   * 缺省 = 默认隔离域（`<HOME>/.opencode-iso`）——与 serve 的作用域一致。
   */
  scope?: OpencodeIsolationScope;
  /**
   * 让已落盘的凭据配置在 serve 里**生效**（**热重载优先**：无进程重启、无端口漂移、
   * 无会话排空）。实现方负责：热重载 → 失败/未确认时**回退到真实重启**并记日志。
   * 返回值 = 热重载结局（'reloaded' / 'deferred' / 'failed' / 'unverified'）。
   */
  applyConfigChange: (request: ConfigChangeRequest) => Promise<ConfigReloadOutcome>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * 一次「让配置生效」的请求。
 *
 * - `reason`：人类可读原因（进日志）。
 * - `providerIDs`：期望在 serve 侧**可见**的 provider id（效果确认用；空 = 不确认）。
 */
export interface ConfigChangeRequest {
  reason: string;
  providerIDs?: string[];
}

/**
 * 兜底读取路径：T16b 起凭据落在**隔离配置域**的 `<data>/opencode/auth.json`
 * （= serve 的 `XDG_DATA_HOME` 作用域；v2.0.28 实测认 XDG_DATA_HOME，不认宿主 HOME）。
 */
export const DEFAULT_AUTH_JSON_PATH = INJECTOR_DEFAULT_AUTH_JSON_PATH;

/**
 * F3 防循环 + C6：model-credentials 命令幂等注入（auth.json 与 opencode.json 双文件）。
 * 先对比后写盘：
 * - auth.json：buildAuthJson 生成新内容与现有对比，相同不写；不同/缺失 →
 *   cleanup 旧文件 → 写新。
 * - opencode.json：provider 段（C6，仅 payload 携带 providerConfigs 时）合并进
 *   现有内容，相同不写；section 为空对象 → 删除 provider key（清空）。
 * - 两文件均未变化 → 跳过写盘 + 不做生效动作（server 无条件回放场景下切断
 *   “生效 → 回放 → 心跳 → 再生效”无限循环）
 * - 任一变化 → 写变化项 → 交由 `applyConfigChange` 让 serve 生效
 *   （**热重载优先**：不重启 serve ⇒ 无端口漂移、无会话排空、无不可用窗口；
 *    热重载失败/未确认时由该回调回退到真实重启）。
 * 返回 { changed, authJsonPath, configPath }（两个路径均供调用方记录下次对比）。
 */
export async function handleModelCredentials(
  providerKeys: ModelCredentialEntry[],
  providerConfigs: Record<string, ModelProviderConfigEntry> | undefined,
  injectedAuthJsonPath: string | null,
  injectedConfigPath: string | null,
  deps: ModelCredentialsHandlingDeps,
): Promise<{
  changed: boolean;
  configChanged: boolean;
  authJsonPath: string;
  configPath: string;
}> {
  // 优先已记录注入路径，兜底隔离配置域的默认路径（容器重启后记录为 null，但文件可能仍在
  // 默认路径 → 靠内容对比判幂等）。
  const scope = deps.scope;
  const authPath = injectedAuthJsonPath ?? scope?.authJsonFile ?? DEFAULT_AUTH_JSON_PATH;
  const configPath = injectedConfigPath ?? scope?.configFile ?? DEFAULT_OPENCODE_CONFIG_PATH;
  const existingAuth = await deps.readContent(authPath);
  const existingConfig = await deps.readConfig(configPath);

  const newAuth = buildAuthJson(providerKeys);
  const authChanged = existingAuth !== newAuth;

  // providerConfigs=undefined（旧 server 负载）→ section=undefined → merge 原样返回
  // → 不触碰 opencode.json（向后兼容）。
  // ⚠️ T16b：providerKeys 一并传入——v2.0.28 只从 provider 段的 `settings.apiKey`
  // 取 API key（auth.json 实测不被采用），不带 key 就会"注入成功但模型无凭据"。
  const section =
    providerConfigs === undefined
      ? undefined
      : buildProviderSection(providerConfigs, providerKeys);
  const newConfig = mergeProviderSection(existingConfig, section);
  const configChanged = newConfig !== existingConfig;

  if (!authChanged && !configChanged) {
    deps.log('[worker] model-credentials：凭据未变化，跳过注入与生效动作');
    return {
      changed: false,
      configChanged: false,
      authJsonPath: authPath,
      configPath,
    };
  }

  if (authChanged) {
    // 保留现有逻辑：清理上一次注入的 auth.json（明文 key 零留存）→ 写新
    if (injectedAuthJsonPath) {
      deps.cleanupAuthJson(injectedAuthJsonPath);
    }
    const injected = deps.writeAuthJson(providerKeys);
    deps.log(
      `[worker] model-credentials：auth.json 已注入 ${injected.authJsonPath}（providerKeys=${providerKeys.length}）`,
    );
  }
  if (configChanged) {
    deps.writeOpencodeConfig(existingConfig, section);
    deps.log(
      `[worker] model-credentials：opencode.json provider 段已更新（providers=[${Object.keys(
        section ?? {},
      ).join(', ')}]，baseUrl 明细见 ${configPath}）`,
    );
  }
  // 文件已落盘 ⇒ 让 serve 生效：**热重载**（不重启进程）。热重载失败或效果未确认时，
  // 由 applyConfigChange 的实现回退到真实重启（并记日志）——静默失败会让 worker
  // 声称一份 serve 从未加载的配置。
  await deps.applyConfigChange({
    reason: 'model-credentials（凭据注入）',
    providerIDs: Object.keys(section ?? {}),
  });
  return { changed: true, configChanged, authJsonPath: authPath, configPath };
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

/** reload-config 命令的依赖面（单测可整体 mock）。 */
export interface ReloadConfigCommandDeps {
  /** 资源重注入（拉控制面资源 → 落盘）。 */
  injectAll: () => Promise<InjectReport>;
  /** 注入报告回写（更新上报用的 skills/tools 清单）。 */
  onInjectReport: (report: InjectReport) => void;
  /** 让配置在 serve 里生效（热重载优先；失败/未确认时回退真实重启）。 */
  applyConfigChange: (
    request: ConfigChangeRequest,
    extraVerify?: () => Promise<ConfigVerification>,
  ) => Promise<ConfigReloadOutcome>;
  /** serve 端点（效果确认读 /api/mcp 与 /api/skill 用）。 */
  serveEndpoint: () => { baseUrl: string; password: string | null };
  log: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * reload-config 命令：重拉资源 → 落盘 → **热重载**（**不重启 serve**）。
 *
 * ⚠️ 这条路径**不再**请求重启：重启会带来端口漂移（要重新注册）、活跃会话排空
 * （无上界延迟）、serve 不可用窗口——而 v2 的文件监听 + `location/reload` 两条路
 * 都能让新配置生效，且**不动 serve 进程**。
 *
 * 效果确认：注入的 MCP server 与 skill 必须在 serve 侧可见；确认失败由
 * `applyConfigChange` 回退到真实重启（静默失败 = worker 声称的配置 serve 从未加载）。
 */
export async function handleReloadConfigCommand(
  command: WorkerCommand,
  deps: ReloadConfigCommandDeps,
): Promise<void> {
  try {
    const report = await deps.injectAll();
    deps.onInjectReport(report);
    deps.log(
      `[worker] reload-config：资源重注入完成（${report.skills.length} skills, ${formatToolInjectionSummary(report)}, ${report.mcpServers.length} mcp servers）`,
    );
    await deps.applyConfigChange(
      { reason: `reload-config（resourceVersion=${command.resourceVersion}）` },
      async () => {
        const mcp = await verifyMcpServersVisible(deps.serveEndpoint(), report.mcpServers);
        if (!mcp.ok) {
          return mcp;
        }
        return verifySkillsVisible(deps.serveEndpoint(), report.skills);
      },
    );
  } catch (err) {
    deps.warn(`[worker] reload-config 资源重注入失败: ${(err as Error).message}`);
  }
}

/** model-credentials 命令的依赖面（单测可整体 mock）。 */
export interface ModelCredentialsCommandDeps {
  /** 注入凭据（auth.json + opencode.json，幂等）；返回落盘路径与变更标记。 */
  injectCredentials: (
    providerKeys: ModelCredentialEntry[],
    providerConfigs: Record<string, ModelProviderConfigEntry> | undefined,
    injectedAuthJsonPath: string | null,
    injectedConfigPath: string | null,
  ) => Promise<{
    authJsonPath: string;
    configPath: string;
    configChanged: boolean;
  }>;
  /** 记录本次注入的落盘路径（下次写入前 cleanup 明文凭据）。 */
  onInjectedPaths: (authJsonPath: string, configPath: string) => void;
  /** provider 配置段实际变更（下次**真重启**后的 reRegister 需全量重探）。 */
  onProviderConfigChanged: () => void;
  /**
   * v2「integration 维度」凭据同步：把**不在配置段里**的凭据（`opencode-go` 这类
   * 无 baseUrl 的内置 integration provider）写进 serve 的 credential store，并把
   * 已吊销的 provider 对应行删掉。
   *
   * ⚠️ 与文件注入**正交且必须在文件未变化时也跑**：auth.json 在 v2 上是 no-op，
   * 只靠"文件变了才动作"会漏掉「store 里压根没有这条凭据」的自愈
   * （这正是"改了 opencode-go 密钥没同步给 opencode 实例"的根因）。
   * 失败由实现方 warn，不阻断文件注入。
   */
  syncIntegrationCredentials?: (request: {
    providerKeys: ModelCredentialEntry[];
    providerConfigs?: Record<string, ModelProviderConfigEntry>;
    revokedProviderIDs?: string[];
  }) => Promise<{ changed: boolean; missing: string[]; failures: string[] }>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * model-credentials 命令：注入凭据文件 → **热重载**（**不重启 serve**）。
 *
 * ⚠️ 这条路径**不再**请求重启（原来每次加凭据都重启整个 serve：端口可能漂移、
 * 活跃会话必须先排空、serve 有不可用窗口）。生效动作由 `injectCredentials` 内部的
 * `applyConfigChange` 承担（热重载 → 失败/未确认时回退真重启）。
 */
export async function handleModelCredentialsCommand(
  command: WorkerCommand,
  injectedAuthJsonPath: string | null,
  injectedConfigPath: string | null,
  deps: ModelCredentialsCommandDeps,
): Promise<void> {
  const payload = command.payload as ModelCredentialsPayload | undefined;
  if (!payload?.providerKeys) {
    deps.warn('[worker] model-credentials 命令缺少 providerKeys 负载，跳过注入');
    return;
  }
  try {
    const result = await deps.injectCredentials(
      payload.providerKeys,
      payload.providerConfigs,
      injectedAuthJsonPath,
      injectedConfigPath,
    );
    deps.onInjectedPaths(result.authJsonPath, result.configPath);
    if (result.configChanged) {
      deps.onProviderConfigChanged();
    }
  } catch (err) {
    deps.warn(`[worker] model-credentials 注入失败: ${(err as Error).message}`);
  }
  // v2 凭据双写的另一半（integration 维度）：即使上面两份文件**都没变**也要跑——
  // store 缺行/吊销残留的自愈就靠它；失败只 warn，不阻断文件注入。
  if (deps.syncIntegrationCredentials) {
    try {
      await deps.syncIntegrationCredentials({
        providerKeys: payload.providerKeys,
        providerConfigs: payload.providerConfigs,
        revokedProviderIDs: payload.revokedProviderIDs,
      });
    } catch (err) {
      deps.warn(
        `[worker] model-credentials：credential store 同步失败（文件注入不受影响）: ${(err as Error).message}`,
      );
    }
  }
}

function printStartup(config: WorkerConfig, opencodeVersion: string): void {
  let browserInfo = '未安装';
  try {
    const r = spawnSync('agent-browser', ['--version'], { encoding: 'utf8', timeout: 3000 });
    browserInfo = (r.stdout ?? '').trim() || (r.stderr ?? '').trim() || 'unknown';
    if (r.status !== 0) browserInfo = `不可用(${browserInfo})`;
  } catch {
    browserInfo = '未安装';
  }
  // v2 恒开鉴权：密码为空不再是"不设鉴权"，而是"serve 启动时 fail-fast"（T3）
  // ⚠️ 这里读的是**配置**的密码（不是 serve 的 effectiveServerPassword）：本函数在 serve
  // 启动**之前**跑（打印的是配置态），v2 自动生成的密码此刻还不存在——换成
  // effectiveServerPassword 会把"开了逃生开关"误报成"未设密码 ⇒ fail-fast"。
  const serveAuth = config.serverPassword
    ? 'Basic Auth（已设 OPENCODE_SERVER_PASSWORD）'
    : config.allowGeneratedPassword
      ? 'Basic Auth（v2 恒开鉴权：未设密码，将从 serve stdout 捕获自动生成密码）'
      : '未设（v2 恒开鉴权：serve 启动时 fail-fast，请设置 OPENCODE_SERVER_PASSWORD）';
  console.log(`[worker] 启动中:
  workerId            = ${config.workerId}
  workerName          = ${config.workerName}
  serverUrl           = ${config.serverUrl}
  standalone          = ${config.standalone ? 'true（跳过注册/心跳/资源拉取）' : 'false'}
  opencodeServePort   = ${config.opencodeServePort === 0 ? '0（OS 随机空闲端口）' : config.opencodeServePort}
  opencodeServeAuth   = ${serveAuth}
  opencodeServeHost   = ${config.opencodeServeHostname}
  opencodeIsolation   = ${config.isolationScope.root}（隔离配置域：宿主机全局配置/插件/AGENTS.md 不在作用域内）
  workerAdvertiseHost = ${config.workerAdvertiseHost}
  heartbeatIntervalMs = ${config.heartbeatIntervalMs}
  workerMaxInstances  = ${config.workerMaxInstances}
  workerTotalTimeoutMs = ${config.workerTotalTimeoutMs === 0 ? '0（禁用：首字后无完成超时）' : config.workerTotalTimeoutMs}
  logLevel            = ${config.logLevel}
  opencodeVersion     = ${opencodeVersion}
  agentBrowser        = ${browserInfo}`);
}

/**
 * 启动提示（引导性，不阻断启动）：仅当 WORKER_ADVERTISE_HOST 未显式设置时触发一次——
 * 此时上报的 capabilities.baseUrl 来源为自动探测（config.ts detectLocalIPv4）：
 * - 探测成功（baseUrl 非 127.0.0.1）→ console.log 输出「已自动探测上报地址」引导提示，
 *   提示多网卡/VPN 场景可显式覆盖。
 * - 探测失败回退 http://127.0.0.1（仅本机可访问）→ console.warn 输出可达地址告警，
 *   控制面与 worker 不在同一主机时控制面连不上 → worker 显示不可用。
 * 已显式设置（即使值恰好为 http://127.0.0.1 的本地开发场景）不提示，避免误报。
 * 独立导出便于单测。
 *
 * ⚠️ **v2：控制面只连 worker 的执行端点，从不直连 opencode serve**
 * （`capabilities.baseUrl` 只被取**主机**部分——见 server 侧 `resolveAdvertiseOrigin`）。
 * ⇒ 提示必须指向「控制面能到达 `<主机>:<执行端点端口>`」（鉴权 X-Worker-Token），
 * **不能**再让运维为控制面把 serve 改成监听非回环（serve 只在 worker 进程内部使用）。
 */
export function warnLoopbackAdvertiseHost(config: WorkerConfig): void {
  if (config.workerAdvertiseHostExplicit) {
    return;
  }
  const advertiseHost = config.workerAdvertiseHost.replace(/\/+$/, '');
  if (config.workerAdvertiseHost === 'http://127.0.0.1') {
    // 自动探测失败回退：保留原 127.0.0.1 可达性告警
    console.warn(
      `[worker] ⚠️  baseUrl=127.0.0.1 仅本机可访问（未设置 WORKER_ADVERTISE_HOST，自动探测本机 IP 失败）\n` +
        `  若控制面与 worker 不在同一主机，控制面将无法连接本 worker → worker 显示不可用。\n` +
        `  请设置 WORKER_ADVERTISE_HOST=<控制面可达的 worker 地址>（如 http://<worker 局域网 IP>）——\n` +
        `  控制面据此访问 ${advertiseHost}:${config.workerExecPort}（执行端点，鉴权走 X-Worker-Token；端口随 capabilities.execPort 上报）。\n` +
        `  无需为控制面把 OPENCODE_SERVE_HOSTNAME 改成 0.0.0.0：v2 下控制面只连执行端点，opencode serve 仅在 worker 进程内部使用（留在回环更安全）。`,
    );
    return;
  }
  // 自动探测成功：输出引导提示（探测到的地址即上报基址，端口随 serve 启动确定后拼接）
  console.log(
    `[worker] ✓ 已自动探测上报地址 ${config.workerAdvertiseHost}（未设置 WORKER_ADVERTISE_HOST）\n` +
      `  最终上报 baseUrl = ${advertiseHost}:<serve 端口>（端口随 serve 启动确定；控制面只取其中的主机部分）。\n` +
      `  控制面据此访问 ${advertiseHost}:${config.workerExecPort}（执行端点，鉴权走 X-Worker-Token）。\n` +
      `  若控制面无法访问该地址（多网卡/VPN 等），请显式设置 WORKER_ADVERTISE_HOST=<控制面可达的 worker 地址>。`,
  );
}

/**
 * 独立模式（WORKER_STANDALONE=true）补写项目配置的 `plugins` 段（T18）。
 *
 * 为什么必须补：独立模式**跳过控制面资源注入**（无 server 可达）⇒ 注入器不会写
 * `<workDir>/opencode.json` 的 `plugins` 段 ⇒ v2 内置插件 `opencode.browser` 不被禁用 ⇒
 * 它占着 `browser` 这个工具名，把平台自己的 browser 工具**静默遮蔽**（工具在注册表里，
 * 但模型的 `tools[]` 里没有它，**全程无报错**——最典型的静默失败）。
 *
 * 做法：复用注入器的**本地写**入口（`applyMcpServers([])`）——它与控制面注入走同一条
 * read-modify-write 路径（同写者），并保证 `plugins` 段带上 `-opencode.browser`。
 * 失败只告警、不阻断启动（配置问题不该让 worker 起不来）。
 */
export function ensureStandaloneProjectConfig(injector: ResourceInjector): void {
  try {
    injector.applyMcpServers([]);
    console.log(
      '[worker] 独立模式：项目配置 plugins 段已补写（已禁用内置 opencode.browser，避免遮蔽平台 browser 工具）',
    );
  } catch (err) {
    console.warn(
      `[worker] 独立模式：项目配置补写失败（不阻断启动，browser 工具可能被内置插件遮蔽）: ${(err as Error).message}`,
    );
  }
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
 * 可执行模型探测的**数据源**：worker 自己那个 serve 的模型目录响应体（原始 JSON）。
 *
 * ⚠️ **v2 下 CLI 不是真值源（v2 事实，本轮修复的根因）**：v2 的 CLI 子命令
 * **不连 worker 拉起的那个 serve**——`opencode models` / `opencode mcp list` 绑的是
 * **共享后台服务**（默认端口 **49374**），读的是**它自己那套配置作用域**。
 * 实测：worker 启动时 `opencode models` 退出码 1（`ServiceUnavailableError: Location plugins
 * did not finish activating`）⇒ 注册**降级不带 executableModels**；`opencode models --standalone`
 * 能跑但读的是 CLI 自己的作用域（**不含 vteam 自配的模型**）。
 * ⇒ 「用 CLI 观测 serve」在 v2 + 隔离方案下**原理上就是错的**（观测的是另一个作用域
 * ⇒ 静默的错误答案）。**真值源 = worker 自己那个 serve 的 `GET /api/model`**（serve 作用域，
 * 与 agent 实际执行时用的是同一份配置）。
 */
export type ExecutableModelsProbe = () => Promise<unknown> | unknown;

/**
 * serve 模型目录项（v2 `Model.Info` 的子集；driver 的 `listModels()` 也产出同形字段）。
 */
interface ServeModelInfo {
  id?: string;
  modelID?: string;
  providerID?: string;
  enabled?: boolean;
}

/**
 * 解析 serve 的模型目录响应 → vteam 口径的 `providerID/modelID` id 列表。
 *
 * - **响应形态两种都认**：`{location, data:[...]}`（**2.0.28 与 2.0.32 都是这个形态**——
 *   2.0.32 见**发布的 `@opencode/client@2.0.32`** `ModelListOutput = { location, data }`）
 *   与**裸数组**（**防御性容忍**：针对假想的未来形态，**并非已知的版本差异**）——复用驱动的
 *   `unwrapV2List`（解包逻辑的单一收敛点，不另写一份）。
 * - **id 口径**：`providerID/modelID`（控制面的过滤按这个格式判定）。
 * - **非法行丢弃**：无 provider 段 / 无 model 段 / 含空白 → 不进上报
 *   （与控制面 `models.service.ts` 的 `indexOf('/') > 0 && !/\s/` 口径一致）。
 * - **`enabled:false` 不算可执行**：v2 独有的"该模型不可用"标记（等价 v1「只列有凭据的
 *   provider」的口径）——与 driver 的 `listModels()` 过滤规则一致。
 * - **去重保序**；结果为空 → `undefined`（**不断言"零可用"**，避免误导 sync 剪枝全部）。
 */
export function parseExecutableModels(payload: unknown): string[] | undefined {
  const models = unwrapV2List<ServeModelInfo>(payload);
  const ids: string[] = [];
  for (const model of models) {
    if (model === null || typeof model !== 'object') {
      continue;
    }
    if (model.enabled === false) {
      continue;
    }
    const providerID = typeof model.providerID === 'string' ? model.providerID : '';
    const modelID =
      typeof model.modelID === 'string' && model.modelID !== ''
        ? model.modelID
        : typeof model.id === 'string'
          ? model.id
          : '';
    if (providerID === '' || modelID === '') {
      continue;
    }
    const id = `${providerID}/${modelID}`;
    if (id.indexOf('/') > 0 && !/\s/.test(id)) {
      ids.push(id);
    }
  }
  const unique = [...new Set(ids)];
  return unique.length > 0 ? unique : undefined;
}

/**
 * 可执行模型探测（**serve 作用域**）：读 worker 自己那个 serve 的模型目录，
 * 解析为 vteam 口径的 id 列表（`providerID/modelID`）。
 *
 * ⚠️ **数据源不是 opencode CLI**：v2 的 CLI 绑共享后台服务（49374），**另一个配置作用域**
 * ⇒ 它的答案既不含 vteam 自配模型，也与 serve 的真实状态不一致。详见
 * `ExecutableModelsProbe` 的注释。
 *
 * - 探测失败（serve 未就绪 / 端点不支持 / 网络错）→ `undefined`
 *   （**不携带** executableModels，server 回退 `/api/model` 拉取；不阻断注册）
 * - 响应为空/无合法行 → `undefined`（不断言"零可用"）
 * - 非法行丢弃；去重保序
 * - probe **可注入**（单测注入假数据源）；生产路径必须注入 serve 作用域的探测函数。
 */
export async function resolveExecutableModels(
  probe: ExecutableModelsProbe,
): Promise<string[] | undefined> {
  let payload: unknown;
  try {
    payload = await probe();
  } catch (err) {
    console.warn(`[worker] 可执行模型探测失败（注册降级不带 executableModels）: ${(err as Error).message}`);
    return undefined;
  }
  return parseExecutableModels(payload);
}

/**
 * T6：注册能力声明（T10 细化并发上限/技能清单；当前单实例 + 已注入的 git 工具族）。
 * F2 C2：serve 实际监听端口随注册上报——随机端口（OPENCODE_SERVE_PORT=0）场景。
 * ⚠️ v2：控制面**不**用它拨号（只连执行端点），上报它只为展示与排障。
 * D2：另上报 capabilities.baseUrl = ${advertiseHost}:${port}（容器内 compose 设
 * WORKER_ADVERTISE_HOST=http://worker；⚠️ v2 起控制面**只取 baseUrl 的主机部分**
 * （`resolveAdvertiseOrigin`：serve 端口不再被使用——控制面只连 worker 执行端点））。
 * T9：接入注入器清单——skills 上报注入器实际注入的 skill 名，tools 合并内置 git 工具族
 * 与注入的自定义工具（去重）。
 * C2：models 为 serve 真实模型 id 列表（resolveModels 结果）；undefined（探测失败）不携带。
 * T10：execPort 为执行端点端口（config.workerExecPort；端点启动失败时传 undefined 不上报，
 * server 不会连到不可用端点）。
 * F4：maxInstances 并发上限配置化——由调用方传入 config.workerMaxInstances（env
 * WORKER_MAX_INSTANCES，默认 5），替代原硬编码 1（单实例导致长任务执行期间新消息
 * 全部被拒"无可用 worker"）；serve 实测支持多 session 并行。
 * Todo 14：capabilities.agentPolicies 透传 injector 注入报告（`injectAll()` 返回
 * `InjectReport.agentPolicies`）——成功 `{enabled:true, names:写入名}`，
 * 失败/中性化 `{enabled:false, names:[]}`；随注册上报（心跳不带 capabilities，
 * 注册/reRegister 经 buildRegisterOptions 间接携带）。
 * 异步化语义：与调用点（serve 就绪后）保持一致，供 registerCurrent/reRegister 链 await。
 */
export async function buildCapabilities(
  port: number | null,
  advertiseHost: string,
  injected: InjectReport = EMPTY_INJECT_REPORT,
  models?: string[],
  execPort?: number,
  maxInstances = 5,
  executableModels?: string[],
): Promise<WorkerCapabilities> {
  const base = advertiseHost.replace(/\/+$/, '');
  const browserTools = isAgentBrowserAvailable() ? BROWSER_TOOLS.map((t) => t.name) : [];
  const tools = [...new Set([...GIT_TOOLS.map((tool) => tool.name), ...browserTools, ...injected.tools])];
  return {
    maxInstances,
    skills: injected.skills,
    tools,
    port: port ?? undefined,
    baseUrl: port !== null ? `${base}:${port}` : undefined,
    ...(models !== undefined ? { models } : {}),
    ...(execPort !== undefined ? { execPort } : {}),
    ...(executableModels !== undefined ? { executableModels } : {}),
    // Todo 14：能力位上报（injector 注入结果透传；防御式拷贝 names 防调用方篡改）。
    agentPolicies: {
      enabled: injected.agentPolicies.enabled,
      names: [...injected.agentPolicies.names],
      // 批次 D-2：`stale` 必须透传——server 的能力位门靠它区分「本地**仍有**受管块
      // （保留 ⇒ 点名该 agent 仍落到角色权限集上）」与「从来就没有过受管块」；
      // 丢掉它 = server 认为该 worker 无受管块 ⇒ 派发时省略 agent 名 ⇒ opencode 退回
      // **引擎默认 agent** ⇒ 角色 `permissions[]` 不生效 ⇒ **权限放大**。
      // 成功路径不带该键（缺席 = 新鲜），故此处只在存在时透传。
      ...(injected.agentPolicies.stale !== undefined
        ? { stale: injected.agentPolicies.stale }
        : {}),
    },
  };
}

/**
 * T4c/T6：组装注册选项。T4c 重启后 serve 端口可能变化（随机端口），reRegister 用当前
 * serveServer.port 重新组装 → capabilities.baseUrl/port 随心跳后注册更新（控制面据此刷新
 * 执行端点的主机；serve 端口本身不再被控制面使用）。
 * T9：injected 为最近一次注入报告（启动注入 + reload-config 重注入后更新），
 * 注册/reRegister 携带真实 skills/tools 清单，保证 worker 详情页数据非陈旧。
 * C2：models 透传 buildCapabilities（resolveModels 结果，失败 undefined 不带）；
 * defaultModelId 来自 config.defaultModelId（env WORKER_DEFAULT_MODEL），未配置不携带。
 * CHANGE 3：maxInstances 可传运行时有效值（本地文件/set-max-instances 覆盖），缺省回落
 * config.workerMaxInstances（env）——既有调用方（单测）行为不变。
 */
export async function buildRegisterOptions(
  config: WorkerConfig,
  port: number | null,
  serveVersion: string,
  cliVersion: string,
  injected: InjectReport = EMPTY_INJECT_REPORT,
  models?: string[],
  execPort?: number,
  executableModels?: string[],
  maxInstances?: number,
): Promise<RegistryClientOptions> {
  const capabilities = await buildCapabilities(
    port,
    config.workerAdvertiseHost,
    injected,
    models,
    execPort,
    maxInstances ?? config.workerMaxInstances,
    executableModels,
  );
  return {
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    workerId: config.workerId,
    workerName: config.workerName,
    // T1：上报值必须是**规范化 semver 串**（`2.0.28`）——控制面调度器按精确串相等过滤
    // worker（`workers.service.ts` 的 opencodeVersion 比较），两端格式必须一致，
    // 不能上报 `opencode v2.0.28` 全文。无法解析的值原样透传（'unknown' 等既有语义）。
    opencodeVersion:
      serveVersion !== 'unknown' ? normalizeOpencodeVersion(serveVersion) : normalizeOpencodeVersion(cliVersion),
    capabilities,
    ...(config.defaultModelId ? { defaultModelId: config.defaultModelId } : {}),
    ...(config.mcpUrl ? { mcpUrl: config.mcpUrl } : {}),
  };
}

/**
 * serve 鉴权口令的**唯一来源**（B1）。
 *
 * 为什么取 serve 的 `effectiveServerPassword` 而不是 env 里那份：v2 未配置
 * OPENCODE_SERVER_PASSWORD 时 opencode 会**自动生成**随机密码并打到 stdout——worker
 * 捕获它之后 env 里依然是空的。谁按 env 那份构造鉴权，谁的每个请求都是 401，而 worker
 * 仍注册成功、看起来健康（最坏的静默失败形态）。
 *
 * 为什么是**函数**而不是字符串：自动生成的密码要等 serve 起来、捕获到之后才知道 ⇒
 * 只能在**每次请求时**现取（与 `serveEndpoint()` / `mcpStatusProbe` 同一套做法）。
 */
export function buildServePasswordProvider(
  serveServer: Pick<OpencodeServer, 'effectiveServerPassword'>,
): () => string | null {
  return () => serveServer.effectiveServerPassword;
}

/**
 * git 凭证落盘（**插件可见的那份 + worker 自己 HOME 那份**）。
 *
 * 为什么必须落到隔离配置域的 HOME：git 工具族是 opencode **插件**，跑在 serve 子进程里，
 * 而 v2 隔离配置域把子进程的 HOME 重定向到隔离域 ⇒ 插件里的 `os.homedir()` 解析到的是
 * 隔离域，不是 worker 自己的 HOME ⇒ 只写 worker HOME ⇒ 平台下发的凭证插件永远读不到
 * （私有仓库 clone/push 失败）。
 */
export function writeGitCredsToServeScope(
  entries: GitCredentialEntry[],
  isolationScope: OpencodeIsolationScope,
): GitCredsResult {
  return writeGitCredsFile(entries, isolationScope.home);
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  const versionInfo = detectOpencodeVersionInfo();
  // T18 单轨：驱动实现只有 v2（v1 驱动已删除）——`resolveOpencodeDriverMode(false)` 会
  // **响亮抛错**（`OPENCODE_V2_ENABLED=false` 不再是「退回 v1」的代码级开关）。
  const driverMode = resolveOpencodeDriverMode(config.opencodeV2Enabled);
  // T1 版本闸门（T18 起单模）：要求主版本 ≥ 2（镜像没换 CLI 规格，继续跑只会拿到 v1 契约）；
  // 认不出版本 → 只告警不判死（计划 D2 风险对策：由控制面按版本串精确过滤兜底）。
  assertOpencodeVersionSupported(versionInfo, {
    logger: { warn: (message) => console.warn(message) },
  });
  const opencodeVersion = formatOpencodeVersion(versionInfo);

  printStartup(config, opencodeVersion);
  warnLoopbackAdvertiseHost(config);

  // T16b：先把隔离配置域的目录建好（serve 的 HOME / XDG_* 全部指向它）。
  ensureIsolationScope(config.isolationScope);

  // K3 修复（T6）：serve 启动前把 git 工具族注入工作目录（<workDir>/.opencode/tools/git.ts，
  // opencode 启动时扫描该目录自动注册；注入失败不阻断启动，工具缺失由后续执行时报错暴露）。
  try {
    const gitToolsPath = installGitTools(config.workDir);
    console.log(`[worker] git 工具族已注入: ${gitToolsPath}`);
  } catch (err) {
    console.error(`[worker] git 工具族注入失败: ${(err as Error).message}`);
  }

  try {
    const browserPath = installBrowserTools(config.workDir);
    if (browserPath) {
      console.log(`[worker] browser 工具已注入: ${browserPath} (agent-browser)`);
    } else {
      console.log('[worker] browser 工具跳过: agent-browser 未安装（本地 dev/旧镜像可忽略，容器镜像已内置）');
    }
  } catch (err) {
    console.error(`[worker] browser 工具注入失败: ${(err as Error).message}`);
  }

  // T3：拉起 opencode serve（spawn detached + 健康检查；失败即退出）。
  // T6（K3）：cwd 必须对齐 workDir——serve 以 cwd 为工作区扫描 .opencode/tools/，
  // 与 installGitTools 注入落点一致，否则注入的工具永远不会被加载。
  const serveServer = new OpencodeServer({
    port: config.opencodeServePort,
    serverPassword: config.serverPassword,
    // T3 逃生开关：v2 恒开鉴权，密码为空时默认 fail-fast；显式开启后改为从 serve stdout
    // 捕获 opencode 自动生成的密码（明文不落日志）。
    allowGeneratedPassword: config.allowGeneratedPassword,
    cwd: config.workDir,
    // T16b：隔离配置域——serve 子进程的 HOME/XDG_* 全部指向它，宿主机的全局配置、
    // 全局插件、全局 AGENTS.md 不在作用域内（v2 没有 --pure 的等价物，T6 实测）。
    isolationScope: config.isolationScope,
    // OmO 开关：⚠️ v2 已无 --pure flag → 该开关不再影响启动参数，仅用于告警
    // （插件抑制由 T16b 的隔离配置域承接）。每次 spawn 时读取，
    // 故开关变更后只要重启 serve 即生效（配置页保存时会触发重启）。
    omoEnabled: () => readOmoEnabled(config.workDir),
  });

  // T8：驱动经工厂构造（业务层只依赖 OpenCodeDriver 接缝；T18 起只有 v2 实现）。
  // serve 随机端口启动成功后在 .then 注入 baseUrl。
  // 会话执行链路（createSession 驱动 → 事件上送）待 T10 回流接线；实例计数由
  // exec-server 的 trackInstanceStart/End 统一驱动（createSession 自身不计数）。
  // D6 (f)：逐消息 system blob 的**插件交接**通道——blob 经交接文件进**模型请求的
  // system 段**（插件不可用时驱动自动退回文本前缀兜底，见 v2-driver 的 routeSystemBlob）。
  const systemHandoff = new SystemHandoffStore(config.workDir, {
    logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
  });
  const driver = createOpencodeDriver({
    mode: driverMode,
    // B1：口令取 serve 的**实际**鉴权口令（配置密码或 v2 自动生成的密码），且**每次请求
    // 时现取**——v2 自动生成的密码要等 serve 起来、从 stdout 捕获后才知道；把它固化在
    // 构造那一刻 = 无口令 ⇒ 驱动每个请求都 401，而 worker 仍注册成功、看起来健康。
    // 绝不从环境变量另读一份（会与 serve 的真实鉴权漂移 ⇒ 全线 401）——与
    // serveEndpoint() / mcpStatusProbe 同一套做法。
    serverPassword: serveServer.effectiveServerPassword ?? undefined,
    serverPasswordProvider: buildServePasswordProvider(serveServer),
    systemHandoff,
  });

  // T4b：资源注入执行器——serve 启动前拉取控制面 skills/tools/mcp-servers 注入
  // <workDir>（.opencode/skills/ + .opencode/tools/ + opencode.json mcp 节），
  // 心跳命令 reload-config 回调复用同一注入器重拉（T4c 重启后生效）。
  const injector = createResourceInjector({
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    workerId: config.workerId,
    workDir: config.workDir,
  });

  // D6 (f)：逐消息 system blob 的**插件交接**产物（`<workDir>/.opencode/plugins/`）。
  // ⚠️ 必须在 serve 启动**之前**落盘（插件发现是按 location 惰性的，但产物要先在位）。
  // 注入失败不阻断启动：驱动会自动退回文本前缀兜底（永远可用的下限）。
  try {
    const handoffPluginPath = injector.applySystemHandoffPlugin();
    console.log(`[worker] system blob 交接插件已注入: ${handoffPluginPath}`);
  } catch (err) {
    console.warn(
      `[worker] system blob 交接插件注入失败（退回文本前缀兜底）: ${(err as Error).message}`,
    );
  }

  // T6/T4c：注册状态（初始注册成功/重启后重注册共享更新；心跳定时器读取 workerId 与间隔）。
  let registeredWorkerId = '';
  let heartbeatIntervalMs = config.heartbeatIntervalMs;

  // worker-self-update Todo 4：自更新执行器（下载 → sha256 校验 → 备份覆盖 → systemd 重启
  // / 无 systemd 落 ready-manual）+ 自动回滚看护。注册在它之前创建，因为 registerCurrent
  // 要顺带把自更新状态字段带进注册报文（register 与 heartbeat 同契约）。
  // 安装目录 = 进程入口 dist/index.js 的上一级（dev 走 tsx src/index.ts 时是 worker/ 根）。
  const updater = new WorkerUpdater({
    serverUrl: config.serverUrl,
    installDir: path.resolve(__dirname, '..'),
    // 空闲判定的唯一事实源与 RestartCoordinator 共用同一份会话计数。
    activeSessionCount: () => getLoad().instances,
    logger: {
      info: (message: string) => console.log(`[worker] ${message}`),
      warn: (message: string) => console.warn(`[worker] ${message}`),
      debug: (message: string) => console.debug(`[worker] ${message}`),
    },
  });

  /**
   * 进程启动时的代码版本（一次性定格）。
   *
   * 为什么必须定格：自更新把新码覆盖到磁盘后，运行中的**旧进程**若每次心跳都现读
   * dist/version.js，会把新版本号上报给 server——UI 显示「已是最新」而进程跑的仍是旧码
   * （线上真实事故：两次更新都「成功」落盘，进程 13 天没重启，实时流修复从未生效）。
   * 启动时解析一次 = 上报本进程真实所跑版本；进程重启后自然读到的就是新码版本。
   */
  const BOOT_CODE_VERSION = resolveCodeVersion();

  /** 自更新状态字段投影（undefined = 不携带该键，缺席语义 = 「本次没上报」）。 */
  const updaterReport = (): {
    updateState?: WorkerUpdateState;
    rolledBack?: boolean;
  } => ({
    ...(updater.state !== undefined ? { updateState: updater.state } : {}),
    ...(updater.rolledBack ? { rolledBack: true } : {}),
  });

  // T9：最近一次注入报告（启动注入 + reload-config 重注入后更新）。
  // 注册/reRegister 据此上报真实 skills/tools 清单——reload-config 后 reRegister 复用，
  // 资源变更后 worker 详情页数据非陈旧。
  let lastInjectReport: InjectReport = EMPTY_INJECT_REPORT;

  // T6 注册（X-Worker-Token）：失败指数退避重试（1s/2s/4s/8s...封顶 30s），
  // 重试耗尽返回 null（由调用方决定退出或降级）。
  // C2：serve 就绪后先探测真实模型列表（resolveModels 失败降级 undefined，不带 models 不阻断注册）。
  // C3（CONF-01）：stability=2——预热期中间态假模型列表需连续 2 次探测一致才上报，杜绝假模型回流。
  /**
   * @param reuseModels true=复用上次探测结果（重注册快路径，跳过 6MB /provider 探测）
   */
  const registerCurrent = async (
    reuseModels = false,
  ): Promise<RegisterResponse | null> => {
    // 重注册快路径（reuseModels）：既不复探（省 ~5s），也不重报全量模型目录
    // （`models` 实测 7702 项 / 253KB 请求体，服务端要逐条 upsert——目录在首次注册
    //  已入库且不会因 serve 重启而变，重复上报纯属浪费，实测注册接口因此耗时 4.8s）。
    const models = reuseModels
      ? undefined
      : await resolveModels(driver, { stability: 2 });
    // models-truth：可执行模型探测 = **worker 自己那个 serve** 的模型目录
    // （`GET /api/model`，serve 作用域；driver 的 listModels() 就是它）。
    // ⚠️ v2 下**不能**用 `opencode models` CLI 探测——CLI 绑共享后台服务（49374），
    // 是**另一个配置作用域**（实测退出码 1 ⇒ 注册降级不带 executableModels）。
    const executableModels = await resolveExecutableModels(() => driver.listModels());
    const result = await registerWorkerWithRetry(
      {
        ...(await buildRegisterOptions(
          config,
          serveServer.port,
          serveServer.versionSemver,
          opencodeVersion,
          lastInjectReport,
          models,
          execPort,
          executableModels,
        )),
        // 自更新状态随注册一并上报（server 落库供 UI 展示；缺席 = 未上报）。
        ...updaterReport(),
        // 代码版本 = 进程启动时定格（杜绝「磁盘已是新码、进程仍是旧码」的虚报，
        // 见 BOOT_CODE_VERSION 注释）。
        codeVersion: BOOT_CODE_VERSION,
      },
      { logger: { warn: (message: string) => console.warn(`[worker] ${message}`) } },
    ).catch((err: Error) => {
      console.error(`[worker] 注册失败（重试耗尽）: ${err.message}`);
      return null;
    });
    // 自更新回滚看护的计数**并行**记录，不改动上面的重试/退避/退出主逻辑：
    // 一次「重试耗尽仍失败」= 1 次失败（内部 8 次重试不拆分计数，避免阈值被网络抖动刷爆）。
    if (result !== null) {
      updater.noteRegisterSuccess();
      // C6：记录本次注册是否携带 models（探测降级 undefined = 未上报）——
      // reRegister 快路径据此决定是否必须全量重探。
      lastModelsReported = models !== undefined;
      // 注册后**全量**重注入（injectAll 幂等：文件覆盖写、受管 agent 已中性化不重复）：
      // ① mcpUrl 覆盖——首次 injectAll 在注册前执行，server 尚无本 worker 的
      //    capabilities.mcpUrl（注册才上报）→ 内置 vteam 地址需注册后重拉才写入 opencode.json；
      // ② 启动竞态自愈——server 未 Ready 时首拉 fetch failed，会缺 skills/agent 节点/MCP，
      //    只补 injectMcp 覆盖不到 skills 与 agent 节点（k8s 实测 .opencode/skills 空、agent:[]）。
      try {
        const report = await injector.injectAll();
        lastInjectReport = report;
        console.log(
          `[worker] 注册后全量重注入完成: ${report.skills.length} skills, ${formatToolInjectionSummary(report)}, ${report.mcpServers.length} mcp servers`,
        );
      } catch (err) {
        console.warn(`[worker] 注册后重注入失败: ${(err as Error).message}`);
      }
    } else {
      updater.noteRegisterFailure();
    }
    return result;
  };

  // T4c：重启后重新注册——serve 随机端口重启后可能变化，用当前 port 重新组装注册选项；
  // 失败不退出（serve 已在新端口运行；控制面只连执行端点，端口不随 serve 变化 ⇒ 仍可达，
  // 再次 reload-config 可把新的能力清单补注册上去）。
  const reRegister = async (): Promise<void> => {
    // 重注册快路径：模型目录没变，跳过稳定性探测（省 ~9s）——但上次注册降级
    // （未上报 models）或 C6 配置刚变更（opencode provider 段可能变了模型集）时
    // 必须全量重探，否则降级永不自愈 / 新模型永不上报。
    const needsFullProbe = !lastModelsReported || configChangedSinceRegister;
    configChangedSinceRegister = false;
    const result = await registerCurrent(!needsFullProbe);
    if (result === null) {
      console.warn(
        '[worker] 重启后重新注册失败：serve 已在新端口运行（控制面只连执行端点，端口不随 serve 变化 ⇒ 仍可达）；' +
          '但控制面侧的能力清单（模型目录/serve 端口）暂时是旧的，可再次触发 reload-config 修复',
      );
      return;
    }
    registeredWorkerId = result.workerId;
    heartbeatIntervalMs = result.heartbeatIntervalMs;
    console.log(`[worker] 重启后重新注册成功: workerId=${result.workerId}`);
  };

  // T4c：重启协调器——**只用于真正需要换进程的场景**（运维重启 / 二进制升级 /
  // 崩溃恢复 / 热重载兜底）。配置类变更（skills/tools/MCP/agent 策略/模型凭据）
  // 一律走下面的热重载路径（不重启 serve ⇒ 无端口漂移、无会话排空、无不可用窗口）。
  const restartCoordinator = new RestartCoordinator({
    activeSessionCount: () => getLoad().instances,
    // B1 配套：serve 重启（随机端口可能变化）后须同步 driver.baseUrl——否则
    // reRegister 的 resolveModels 探测打到旧端口 fetch failed，capabilities.models 恒空。
    restart: async () => {
      const baseUrl = await serveServer.restart();
      driver.baseUrl = baseUrl;
      // serve 重启 ⇒ 插件要重新加载 ⇒ 就绪标记作废（否则驱动会误信"插件已加载"）
      systemHandoff.invalidateReady();
      return baseUrl;
    },
    // 独立模式无控制面：不注入 reRegister（重启后无需重新注册，避免无谓重试阻塞重启）
    ...(config.standalone ? {} : { reRegister }),
    logger: {
      info: (message: string) => console.log(`[worker] ${message}`),
      warn: (message: string) => console.warn(`[worker] ${message}`),
      error: (message: string) => console.error(`[worker] ${message}`),
    },
  });

  // ── 配置热重载（opencode v2 原生；**不重启 serve 进程**）────────────────────
  // serve 端点**每次调用时读取**（serve 重启可能换端口）；密码取 serve 的**实际配置**
  // （effectiveServerPassword = 配置密码或 v2 自动生成的密码）——不从环境变量另读
  // 一份（会与 serve 的真实鉴权漂移 ⇒ 全线 401）。与 mcp-status-probe 同一套做法。
  const serveEndpoint = (): { baseUrl: string; password: string | null } => ({
    baseUrl: serveServer.baseUrl ?? '',
    password: serveServer.effectiveServerPassword,
  });

  // 执行端点（pending 闸门的数据源）：命令处理器注册在它之前创建 ⇒ 用 holder 打破 TDZ。
  let execServerRef: ExecServer | null = null;

  const configReloader = new ConfigReloader({
    endpoint: serveEndpoint,
    // pending 闸门：`POST /api/location/reload` 会**取消**待答复的表单/权限
    // （实测 opencode v2.0.28）⇒ 有 pending 时绝不重载，改走文件监听路径。
    // 检测能力复用 exec-server 的同一份（逐会话、与 location 无关）。
    // 执行端点尚未就绪 ⇒ 结论不完整 ⇒ 保守地不重载。
    pendingProbe: async () =>
      execServerRef
        ? execServerRef.detectPendingRequests()
        : { forms: 0, permissions: 0, sessions: [], incomplete: true },
    logger: {
      info: (message: string) => console.log(message),
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    },
  });

  /**
   * 让已落盘的配置在 serve 里生效：**热重载优先**（不重启进程）。
   *
   * 三条出路（互斥，按序）：
   * 1. 热重载成功（且效果已确认）→ 结束（serve 进程、端口、会话全不变）；
   * 2. 有待答复的表单/权限 → **不重载**（改由文件监听路径生效，不取消任何待答复项）；
   * 3. 热重载失败 / 效果未确认 → **回退到真实重启**（并记日志）——
   *    静默失败会让 worker 声称一份 serve 从未加载的配置。
   */
  const applyConfigChange = async (
    request: ConfigChangeRequest,
    extraVerify?: () => Promise<ConfigVerification>,
  ): Promise<ConfigReloadOutcome> => {
    const providerIDs = request.providerIDs ?? [];
    const verify = combineVerifiers([
      providerIDs.length > 0
        ? () => verifyProvidersVisible(serveEndpoint(), providerIDs)
        : undefined,
      extraVerify,
    ]);
    const result = await configReloader.reload(request.reason, verify);
    if (result.outcome === 'reloaded') {
      console.log(
        `[worker] ${request.reason}：serve 已热重载（serve 进程未重启，端口与会话不变）`,
      );
      return result.outcome;
    }
    if (result.outcome === 'deferred') {
      console.warn(
        `[worker] ${request.reason}：存在待答复的表单/权限，location/reload 会取消它们 ⇒ ` +
          '已跳过确定性热重载；改由 opencode v2 的文件监听路径生效（不取消任何待答复项）',
      );
      return result.outcome;
    }
    console.warn(
      `[worker] ${request.reason}：热重载未生效（${result.detail}）⇒ 回退到真实重启`,
    );
    const decision = await restartCoordinator.requestRestart(
      `${request.reason}（热重载兜底）`,
    );
    if (decision === 'pending') {
      console.log(`[worker] ${request.reason}：存在活跃会话，重启挂起（会话归零后自动执行）`);
    }
    return result.outcome;
  };

  // T8c：MCP 状态探测器（30s 节流——不能每 10s 心跳都打一次 serve，Metis 高优补项 7）。
  // 数据源 = **worker 自己那个 serve** 的 `GET /api/mcp`（Basic Auth 用 serve 密码）。
  // ⚠️ **不是** opencode CLI：v2 的 CLI 子命令绑共享后台服务（49374），读的是另一个
  // 配置作用域 ⇒ 观测不到 worker 的 serve（实测 CLI 答"没有 MCP 服务器"而 serve 是 connected）。
  // 心跳回调携带 getStatus() 快照（节流窗口内复用缓存），首次探测失败为空数组不阻断心跳。
  const mcpStatusProbe = new McpStatusProbe({
    // serve 端点**每次探测时读取**：serve 重启可能换端口（随机端口场景），
    // 且密码取 serve 的**实际配置**（effectiveServerPassword = 配置密码或 v2 自动生成的
    // 密码）——不从环境变量另读一份（会与 serve 的真实鉴权漂移 ⇒ 全线 401）。
    endpoint: () => ({
      baseUrl: serveServer.baseUrl ?? '',
      password: serveServer.effectiveServerPassword,
    }),
    // cwd 对齐 workDir：内置 vteam MCP 的注入配置落点（<workDir>/opencode.json）
    cwd: config.workDir,
    logger: {
      warn: (message: string) => console.warn(`[worker] ${message}`),
    },
  });

  // 心跳单次发送（worker-self-update Todo 4 抽出）：定时器与「自更新执行完毕补报状态」
  // 共用同一条路径，保证两处上报字段与失败处理完全一致。
  const sendHeartbeatOnce = async (): Promise<void> => {
    // F2 M4：load 上报真实活动会话数（instance-tracker 计数，
    // T10 会话执行接线后由驱动调用点 trackInstanceStart/End 驱动）
    const load: WorkerLoad = getLoad(config.workerMaxInstances);
    const health: WorkerHealth = serveServer.isRunning ? 'ok' : 'degraded';
    try {
      // 回滚判定排在心跳之前：真触发回滚时，rolledback 状态要在**这一轮**就报上去，
      // server 的指令收敛（convergePendingUpdateCommand）才能及时清掉 pending。
      await updater.maybeRollback();
      const heartbeat = await sendHeartbeat({
        serverUrl: config.serverUrl,
        workerToken: config.workerToken,
        workerId: registeredWorkerId,
        load,
        health,
        // T8c：MCP 状态快照（节流缓存，30s 内复用）
        mcpStatus: await mcpStatusProbe.getStatus(),
        ...updaterReport(),
        // 同 register：上报进程启动时定格的版本，不现读磁盘文件。
        codeVersion: BOOT_CODE_VERSION,
      });
      // T4a：心跳响应携带的下行命令 → 分派处理（reload-config 注入+重启）
      dispatchCommands(heartbeat.commands ?? []);
    } catch (err) {
      console.warn(`[worker] 心跳失败: ${(err as Error).message}`);
    }
  };

  // T4b：注册命令处理回调（T4a 挂载点）——reload-config 触发资源重拉 + 注入 +
  // **热重载**（不再重启 serve；有待答复项时改走文件监听路径）。
  // C5b：记录上一次注入的 auth.json 路径（下次写入前 cleanup，不留存旧凭据明文）。
  // C6：同理记录 opencode.json（config 无明文凭据，写盘幂等，不需 cleanup）。
  let injectedAuthJsonPath: string | null = null;
  let injectedConfigPath: string | null = null;
  // C6：上次成功注册是否携带了 models（探测降级 undefined = false）。快路径
  // （reRegister 复用）只在“上次已上报过 models 且配置自注册后未变”时跳过探测——
  // 否则首次注册降级（启动预热竞态）将永不自愈，C6 配置变更的新模型也永不上报。
  let lastModelsReported = false;
  let configChangedSinceRegister = false;
  onCommands(async (commands) => {
    for (const command of commands) {
      if (command.type === WORKER_COMMAND_TYPES.RELOAD_CONFIG) {
        await handleReloadConfigCommand(command, {
          injectAll: () => injector.injectAll(),
          // T9：重注入后更新注入清单，重启后的 reRegister 上报最新 skills/tools
          onInjectReport: (report) => {
            lastInjectReport = report;
          },
          applyConfigChange,
          serveEndpoint,
          log: (message) => console.log(message),
          warn: (message) => console.warn(message),
        });
      }
      if (command.type === WORKER_COMMAND_TYPES.MODEL_CREDENTIALS) {
        await handleModelCredentialsCommand(
          command,
          injectedAuthJsonPath,
          injectedConfigPath,
          {
            // F3 防循环：内容幂等注入——auth.json 与 opencode.json（C6）内容均未
            // 变化时跳过写盘与生效动作，切断“server 无条件回放 → 生效 → 回放”
            // 无限循环。
            injectCredentials: (keys, providerConfigs, authPath, cfgPath) =>
              handleModelCredentials(keys, providerConfigs, authPath, cfgPath, {
                readContent: async (authJsonPath) => {
                  try {
                    return await fs.promises.readFile(authJsonPath, 'utf8');
                  } catch {
                    return null;
                  }
                },
                writeAuthJson: (providerKeys) =>
                  writeAuthJson(providerKeys, config.isolationScope),
                cleanupAuthJson,
                readConfig: async (configPath) => {
                  try {
                    return await fs.promises.readFile(configPath, 'utf8');
                  } catch {
                    return null;
                  }
                },
                writeOpencodeConfig: (existingRaw, section) =>
                  writeOpencodeConfig(existingRaw, section, config.isolationScope),
                scope: config.isolationScope,
                applyConfigChange,
                log: (message) => console.log(message),
                warn: (message) => console.warn(message),
              }),
            onInjectedPaths: (authPath, cfgPath) => {
              injectedAuthJsonPath = authPath;
              injectedConfigPath = cfgPath;
            },
            // C6：provider 配置段实际变更 → **下次**真重启后的 reRegister 必须全量重探
            // （新模型进目录 / baseUrl 变化，快路径复用会漏报）
            onProviderConfigChanged: () => {
              configChangedSinceRegister = true;
            },
            // v2 凭据双写的另一半：**integration 维度**（无 baseUrl 的内置 provider
            // 如 opencode-go 进不了 opencode.json 配置段 ⇒ key 只能落 serve 的
            // credential store；auth.json 在 v2 上是 no-op）。端点每次现读（重启可能
            // 换端口），密码取 serve 的实际配置（effectiveServerPassword）。
            syncIntegrationCredentials: (request) =>
              syncIntegrationCredentials(request, {
                endpoint: serveEndpoint(),
                log: (message) => console.log(message),
                warn: (message) => console.warn(message),
              }),
            log: (message) => console.log(message),
            warn: (message) => console.warn(message),
          },
        );
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
            writeContent: (entries) => writeGitCredsToServeScope(entries, config.isolationScope),
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
      if (command.type === WORKER_COMMAND_TYPES.UPDATE_WORKER) {
        // 自更新：下载 + sha256 校验 + 备份覆盖 + （systemd）重启，无 systemd 则落
        // ready-manual。执行可能耗时数秒且内部自带单飞锁，故**放后台**跑，不阻塞同批
        // 其余命令；结束后立刻补一次心跳，让 UI 尽快看到 restarting/ready-manual/rolledback。
        // 指令未携带目标版本**不跳过**（wire 契约：降级执行，只要求 version.json 存在）。
        void (async () => {
          try {
            await updater.handleCommand(command);
          } catch (err) {
            // handleCommand 内部已兜底不抛；这里只防未来改动引入的未预期异常，
            // 自更新失败绝不能把 worker 带下线（继续心跳，等下轮重试）。
            console.warn(`[worker] update-worker 执行异常: ${(err as Error).message}`);
          }
          await sendHeartbeatOnce();
        })();
      }
    }
  });

  // T4c：活跃会话归零时检查挂起的重启（T10 会话执行接入 trackInstanceStart/End 后自动触发）
  // worker-self-update：同一空闲跃变同时驱动自更新续跑——指令到达时正忙被 defer 的
  // 更新、以及「新码已落盘但重启被会话挡下」的 ready-manual，都在此归零后续跑
  // （旧实现此处无钩子 = 新码躺磁盘、进程跑旧码，修复数周不生效的线上事故根因）。
  onActiveSessionsIdle(() => {
    restartCoordinator.checkPending();
    void updater.retryPendingUpdate().catch((err: unknown) => {
      console.warn(`[worker] 空闲续跑更新失败（不影响主流程）: ${String(err)}`);
    });
  });

  // T6：事件上送通道（进程内单例，seq 从 1 起单调递增 + F2 M1 bootId 区分重启）。
  // 事件产生（session.updated/task.completed 等）待 T10 回流接线（C1 并行任务）。
  const eventSender = createEventSender({
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
    totalTimeoutMs: config.workerTotalTimeoutMs,
    serverBaseUrl: config.serverUrl,
    browserProfileRoot: config.workDir,
    // 独立模式（WORKER_STANDALONE）下挂载 POST /config/* 本地配置下推；注册模式不挂载
    standalone: config.standalone,
    resourceInjector: injector,
    // GET /agents 未显式传 directory 时的回落值：与 serve cwd（config.workDir）一致，
    // 保证列出的 opencode agent 集合与实际执行时发现的集合相同
    workDir: config.workDir,
    // git 凭证落到**插件可见**的 HOME（隔离配置域）——serve 子进程的 HOME 被重定向到那里，
    // 插件里的 os.homedir() 解析到的也是那里（只写 worker 自己 HOME ⇒ 插件读不到）。
    gitCredsHome: config.isolationScope.home,
    // T17：serve 日志模型错误检测数据源——awaitCompletion 每轮轮询读 recentErrors(会话 id)，
    // 命中模型 API 错误（Rate limit/Free usage 等不透传 message.info.error；已按会话过滤避免
    // stale 泄漏）时提前 abort + 抛错（错误文本透传前端，不再空等首字超时）
    serveErrorReader: (sessionID) => serveServer.recentErrors(5, sessionID),
    // 兜底证据源：模型错误不可提取时，原始 serve 日志尾部随失败原因上报（失败必带证据）
    serveLogReader: (sessionID) => serveServer.recentLogTail(20, sessionID),
    // OmO 配置保存后重启 serve：opencode 只在启动时读 OmO 配置，不重启则新会话仍用旧模型。
    // 复用 RestartCoordinator（无活跃会话立即重启 / 有则挂起等归零），故不会打断进行中的会话。
    restartServe: (reason: string) => restartCoordinator.requestRestart(reason),
    // 配置热重载（**不重启 serve 进程**）：独立模式的 POST /config/reload 用。
    // 注册模式的配置变更走心跳命令路径（reload-config / model-credentials）。
    reloadServe: async (reason: string): Promise<ConfigReloadOutcome> =>
      applyConfigChange({ reason }).catch((err: unknown) => {
        console.warn(`[worker] ${reason}：热重载异常: ${String(err)}`);
        return 'failed' as ConfigReloadOutcome;
      }),
  });
  // 执行端点就绪引用（配置热重载的 pending 闸门数据源；命令处理器注册在它之前）
  execServerRef = execServer;
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
  // 独立模式（WORKER_STANDALONE=true）：跳过控制面资源注入（无 server 可达），
  // 本地工具注入（git/browser，上方已执行）与 omo 种子保留；随后跳过注册/心跳。
  void (async () => {
    if (config.standalone) {
      console.log('[worker] 独立模式（WORKER_STANDALONE）：跳过控制面资源注入/注册/心跳');
      // T18：注入被跳过 ⇒ `plugins` 段没人写 ⇒ v2 内置 `opencode.browser` 会静默遮蔽
      // 平台自己的 browser 工具 ⇒ 此处补写（详见 ensureStandaloneProjectConfig）。
      ensureStandaloneProjectConfig(injector);
      try {
        const seeded = seedOmoAgentModels(config.workDir);
        if (seeded) {
          console.log(
            `[worker] omo 模型种子已写入: ${Object.entries(seeded).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          );
        }
      } catch (err) {
        console.warn(`[worker] omo 模型种子写入失败（不阻断启动）: ${(err as Error).message}`);
      }
    } else {
    try {
      const report = await injector.injectAll();
      // T9：首次注入清单作为注册时上报的真实 skills/tools
      lastInjectReport = report;
      console.log(
        `[worker] 平台资源注入完成: ${report.skills.length} skills, ${formatToolInjectionSummary(report)}, ${report.mcpServers.length} mcp servers`,
      );
      // omo 子代理模型种子：新数据卷无配置文件时写入内置默认（已有则跳过，用户页面/API 修改优先）
      try {
        const seeded = seedOmoAgentModels(config.workDir);
        if (seeded) {
          console.log(
            `[worker] omo 模型种子已写入: ${Object.entries(seeded).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          );
        }
      } catch (err) {
        console.warn(`[worker] omo 模型种子写入失败（不阻断启动）: ${(err as Error).message}`);
      }
    } catch (err) {
      console.warn(
        `[worker] 平台资源注入失败（继续启动 serve，心跳命令可重拉）: ${(err as Error).message}`,
      );
    }
    }

    try {
      const baseUrl = await serveServer.start();
      // T4：serve 就绪后注入实际 baseUrl（随机端口场景，driver 后续请求才有目标地址）
      driver.baseUrl = baseUrl;
      // 新起的 serve 还没加载插件 ⇒ 就绪标记作废（驱动会等插件加载，或退回文本前缀）
      systemHandoff.invalidateReady();
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

      if (config.standalone) {
        console.log(
          `[worker] 独立模式就绪: workerId=${config.workerId}, serve=${driver.baseUrl ?? '(未就绪)'}, execPort=${execPort ?? '(未绑定)'}（跳过注册/心跳）`,
        );
        return;
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

      // 心跳：间隔以 server 返回为准（T7 协议 heartbeatIntervalMs）。
      heartbeatTimer = setInterval(() => {
        void sendHeartbeatOnce();
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
  try {
    main();
  } catch (err) {
    // 启动期 fail-fast（如 T1 版本闸门 / T3 恒开鉴权）：打可操作错误后退出，不吐栈噪声
    console.error(`[worker] 启动失败: ${(err as Error).message}`);
    process.exit(1);
  }
}
