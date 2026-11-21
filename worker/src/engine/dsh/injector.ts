/**
 * dsh 引擎的注入器与凭据应用器（P4 实现）。
 *
 * 职责：把 vteam 的注入快照落成 dsh 的 **profile patch 文件**（`cordis.patch.yml` 形态），
 * 并解析出 spawn 时需要注入的环境变量（模型凭据）。
 *
 * ## 为什么凭据走 env 而不是写进 patch
 *
 * P0 报告约束 C3：DSH 的 provider 用 `apiKeyEnv: <变量名>` 声明凭据**引用**，
 * 真实值从启动环境解析。patch 文件会落盘在工作目录里（可能被读取/转发），
 * **把明文 key 写进 patch 等于把凭据留在磁盘**。故：patch 只写变量名，值走 spawn env。
 *
 * @module engine/dsh/injector
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WORKER_TOKEN_HEADER } from '../../client/registry-client';
import { resolveMcpHeaders, stringifyMcpHeaders } from '../../resources/mcp-headers';
import {
  McpServerRecord,
  resolveVteamMcpTimeoutMs,
  VTEAM_MCP_SERVER_NAME,
} from '../../resources/mcp-servers-record';
import type {
  EngineConfigSnapshot,
  EngineMcpServerSpec,
  EngineModelCredential,
  CredentialApplier,
  ResourceInjector,
  WorkerEngineKind,
} from '../types';
import { buildDshPatch, type DshMcpMount, type DshProviderRoute } from './patch-builder';

/** patch 文件名（落在 workDir 的 `.vteam/` 下，避免污染引擎私有目录）。 */
export const DSH_PATCH_FILENAME = 'dsh-profile.patch.yml';

/** `/mcp-servers` 分页大小（与 opencode 注入器同口径）。 */
const DSH_MCP_REGISTRY_PAGE_SIZE = 100;

/** 凭据环境变量名前缀（providerID 大写化后拼接，避免与宿主 env 撞名）。 */
export const DSH_CREDENTIAL_ENV_PREFIX = 'VTEAM_PROVIDER_';

/**
 * providerID → 凭据环境变量名。
 *
 * 例：`deepseek-official` → `VTEAM_PROVIDER_DEEPSEEK_OFFICIAL_KEY`。
 * 用前缀隔离的理由：worker 进程的 env 会传给子进程，通用名（如 `OPENAI_API_KEY`）
 * 可能被宿主的其它工具读到。
 */
export function credentialEnvName(providerID: string): string {
  const normalized = providerID.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `${DSH_CREDENTIAL_ENV_PREFIX}${normalized}_KEY`;
}

/** providerID → 端点环境变量名（自定义网关需要 baseURL）。 */
export function baseUrlEnvName(providerID: string): string {
  const normalized = providerID.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `${DSH_CREDENTIAL_ENV_PREFIX}${normalized}_BASE_URL`;
}

/** dsh 注入器构造参数。 */
export interface DshInjectorOptions {
  /** 平台 MCP 地址（vteam 的 platform-mcp 端点）。 */
  platformMcpUrl?: string;
  /** 平台 MCP 鉴权头（worker token）。 */
  platformMcpHeaders?: Record<string, string>;
  /** vteam 工具 MCP server 的启动命令（P4b：mcp-tool-server；缺省不挂）。 */
  toolMcpCommand?: { command: string; args: string[]; env?: Record<string, string> };
  /** provider 路由的线协议（缺省按 providerID 猜：deepseek→openai-completions）。 */
  providerApi?: Record<string, string>;
  /** provider 路由的 baseURL（缺省按凭据里的 baseUrl 或 providerID 猜）。 */
  providerBaseUrl?: Record<string, string>;
  /**
   * provider 路由的请求头（如 opencode-go 网关要求 `x-opencode-session`）。
   * 注意：opencode 会话头的值会按会话变化 → 若网关强制唯一值，见 `providerHeadersFor`。
   */
  providerHeaders?: Record<string, Record<string, string>>;
  /**
   * 系统提示词（persona）。写入 patch 时用
   * `!!js process.env.DSH_SYSTEM_PROMPT ?? '<fallback>'`，真值由驱动 spawn 时经 env 注入。
   *
   * 依据：DSH 的 `dsh-system-prompt` 支持 `personaPrefix`（Config schema 见
   * packages/core/system-prompt/src/index.ts:437-446），且 `sdk-minimal` profile
   * 已用 `DSH_SYSTEM_PROMPT` 环境变量做范例（cordis.patch.yml:113-118）。
   */
  persona?: { prefix: string; suffix?: string };
  /**
   * 平台 MCP 列表拉取参数（`GET /mcp-servers?enabled=true`）。
   *
   * ⚠️ **缺它就是「注册的 MCP 不会下发」**：此前 dsh 只挂内置 `platformMcpUrl` 一条，
   * 平台「MCP 服务器」页里注册的其余条目在 dsh worker 上**永远不会出现在 patch 里**
   * ⇒ worker 内的 agent 看不到这些工具，且没有任何报错（patch 只是少了几行）。
   * 传了本参数才会拉取并把每一条落成 `dsh-mcp-client` 挂载。
   */
  mcpRegistry?: {
    /** server 基址（config.serverUrl）。 */
    serverUrl: string;
    /** X-Worker-Token（拉取鉴权）。 */
    workerToken: string;
    /** worker 全局 id（`x-worker-id`：server 按它覆盖内置 vteam 地址）。 */
    workerId: string;
    /** fetch 注入点（测试用）。 */
    fetchImpl?: typeof fetch;
  };
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

/**
 * dsh 的 `ResourceInjector` 实现。
 *
 * 产物 = 一个 patch 文件（`<workDir>/.vteam/dsh-profile.patch.yml`）。
 * worker 每轮注入即**整体重写**（幂等、可审计；不像 opencode 那样需要 manifest 合并——
 * dsh 的 patch 是纯声明式，重写即等价于"上一次的受管块被覆盖"）。
 */
export class DshResourceInjector implements ResourceInjector {
  readonly kind: WorkerEngineKind = 'dsh';

  private readonly options: DshInjectorOptions;
  private readonly logger: NonNullable<DshInjectorOptions['logger']>;

  /**
   * 预设 roster 的 patch 文本（P6）。
   *
   * 由调用方生成（`renderPresetPatch(buildBuiltinRoster(), default)`），
   * `apply()` 时追加到 patch 尾部。为什么用「预渲染文本」而不是结构体：
   * roster 是**静态出厂角色**（7 个），渲染一次比每轮重新构造简单且稳定。
   */
  private presetRosterPatch: string | null = null;

  /**
   * 最近一次成功写盘的 patch **内容签名**（sha256 前 16 位）。
   *
   * 为什么需要：DSH 的运行时在 spawn 时读 `--patch`，**不会**跟着文件变化重载。
   * 所以「配置变了」必须能被**判定**，才能在空闲运行时上重建（见调用方的
   * `refreshPatch` 语义）。仅比较 mtime 不可靠（并发写、时钟回拨），
   * 且调用方常常重算出**完全相同**的内容（幂等轮次）——那种情况不该重启运行时。
   */
  private lastSignature: string | null = null;

  /** 最近一次成功写盘的签名（null = 还没写过）。 */
  get currentSignature(): string | null {
    return this.lastSignature;
  }

  /** 设置 preset roster patch（null = 不注入 roster，退回单 persona）。 */
  setPresetRosterPatch(patch: string | null): void {
    this.presetRosterPatch = patch;
  }

  constructor(options: DshInjectorOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? console;
  }

  /**
   * 写入串行化链（避免并发 apply 撞同一个 tmp 文件）。
   *
   * 实测：启动时"同步 apply（基本配置）"与"异步 apply（preset roster）"可能并发，
   * 两者用同一个 `<patch>.tmp-<pid>` 名字 → 后者的 rename 找不到文件（ENOENT）。
   * 故所有写操作排队。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * 应用注入快照 → 写 patch 文件。
   *
   * @param snapshot - 引擎无关快照（skills/tools/mcp/agentPolicies/credentials）。
   * @param workDir - 注入根（vteam 资产目录由此派生）。
   * @returns patch 文件绝对路径（供驱动 spawn 时 --patch 引用）。
   */
  async apply(snapshot: EngineConfigSnapshot, workDir: string): Promise<string> {
    // 串行化：把本次写入排到链尾（见 writeChain 说明）
    const task = this.writeChain.then(() => this.applyNow(snapshot, workDir));
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  /** 实际写入（由 apply 串行化调用）。 */
  private async applyNow(snapshot: EngineConfigSnapshot, workDir: string): Promise<string> {
    const patchPath = path.join(workDir, '.vteam', DSH_PATCH_FILENAME);
    const providers = snapshot.modelCredentials.map((cred) => this.toProviderRoute(cred));
    const mcpMounts = await this.buildMounts(snapshot);

    let content = buildDshPatch({
      providers,
      mcpMounts,
      ...(this.options.persona === undefined ? {} : { persona: this.options.persona }),
    });

    // P6：追加 agent-preset roster（多角色共享运行时的关键）
    if (this.presetRosterPatch !== null) {
      content += `\n${this.presetRosterPatch}`;
    }

    await fs.promises.mkdir(path.dirname(patchPath), { recursive: true });
    // 原子写：先写临时文件再 rename（避免 dsh 读到半个文件导致启动失败）
    const tmp = `${patchPath}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, patchPath);
    this.lastSignature = createHash('sha256').update(content).digest('hex').slice(0, 16);

    this.logger.info(
      `[engine/dsh] patch 已写入 ${patchPath}（providers=${providers.length}, mcp=${mcpMounts.length}` +
        `${mcpMounts.length > 0 ? `: ${mcpMounts.map((m) => m.serverName).join(', ')}` : ''}）`,
    );
    return patchPath;
  }

  /** 清理产物（worker 卸载/切换引擎时）。 */
  async cleanup(workDir: string): Promise<void> {
    const patchPath = path.join(workDir, '.vteam', DSH_PATCH_FILENAME);
    try {
      await fs.promises.rm(patchPath, { force: true });
    } catch (err) {
      this.logger.warn(`[engine/dsh] 清理 patch 失败：${(err as Error).message}`);
    }
  }

  /**
   * 系统提示词对应的 **env 变量**（spawn 时注入；patch 只写变量名）。
   *
   * 为什么走 env 而非写进 patch：提示词数千字，写进 patch 会让文件巨大 + 内容落盘；
   * env 注入对齐 `sdk-minimal` 的 `DSH_SYSTEM_PROMPT` 惯例，且支持按会话切换人设。
   */
  personaEnv(): Record<string, string> {
    if (this.options.persona === undefined) return {};
    const env: Record<string, string> = {
      DSH_SYSTEM_PROMPT: this.options.persona.prefix,
    };
    if (this.options.persona.suffix !== undefined) {
      env.DSH_SYSTEM_PROMPT_SUFFIX = this.options.persona.suffix;
    }
    return env;
  }

  /** 凭据 → provider 路由声明。 */
  private toProviderRoute(cred: EngineModelCredential): DshProviderRoute {
    const api =
      this.options.providerApi?.[cred.providerID] ??
      (cred.providerID.includes('anthropic') ? 'anthropic-messages' : 'openai-completions');
    const baseURL =
      this.options.providerBaseUrl?.[cred.providerID] ??
      cred.baseUrl ??
      // 兜底：DeepSeek 官方端点（DSH 的 deepseek-official 路由默认值一致）
      (cred.providerID.startsWith('deepseek')
        ? 'https://api.deepseek.com/v1'
        : `https://${cred.providerID}/v1`);
    const headers = this.options.providerHeaders?.[cred.providerID];
    return {
      route: cred.providerID,
      apiKeyEnv: credentialEnvName(cred.providerID),
      api,
      baseURL,
      ...(headers === undefined ? {} : { headers }),
      models:
        cred.models !== undefined && cred.models.length > 0
          ? cred.models.map((m) => ({ id: m.id, name: m.name }))
          : // 兜底：只声明凭据里的那一个模型（平台未提供目录时）
            (() => {
              // 兜底也要覆盖默认模型（DSH_MODEL），否则 patch 只声明
              // deepseek-v4-flash、而派发的是 deepseek-v4.1-flash → initialize 失败。
              const ids = [
                ...new Set(
                  [cred.modelID, process.env.DSH_MODEL].filter(
                    (id): id is string => typeof id === 'string' && id.length > 0,
                  ),
                ),
              ];
              return (ids.length > 0 ? ids : ['deepseek-v4-flash']).map((id) => ({
                id,
                name: id,
              }));
            })(),
    };
  }

  /** 构造 MCP 挂载清单（平台 MCP + 工具 MCP）。 */
  /**
   * 构造 MCP 挂载清单。
   *
   * 三个来源（按优先级合并，同名后者覆盖前者 ⇒ 平台注册表**优先**）：
   * 1. 内置平台 MCP（`platformMcpUrl`，vteam 核心工具面）；
   * 2. 平台「MCP 服务器」注册表（`GET /mcp-servers?enabled=true`）；
   * 3. worker 内置工具 MCP（`toolMcpCommand`，P4b，可降级）。
   *
   * ⚠️ **第 2 条此前完全缺失**：dsh 只挂内置 `vteam`，平台页面上注册的其余 MCP
   * 在 dsh worker 上永远不出现——worker 内的 agent 看不到工具，且没有任何报错。
   * 这就是「dsh worker 类型下注册的 MCP 不会自动下发」的根因。
   *
   * 拉取失败**不清空**已挂载条目：宁可让 agent 跑在**上次已知**的工具面上
   * （patch 是整体重写，故「上次」= 调用方仍在传的 options/内置条目），
   * 也不要在一次控制面抖动里把 agent 的工具全拔掉。
   */
  private async buildMounts(snapshot: EngineConfigSnapshot): Promise<DshMcpMount[]> {
    /** serverName → mount（后者覆盖前者；保留首次出现的顺序）。 */
    const byName = new Map<string, DshMcpMount>();
    const put = (mount: DshMcpMount): void => {
      byName.set(mount.serverName, mount);
    };

    // ① 内置平台 MCP
    if (this.options.platformMcpUrl !== undefined && this.options.platformMcpUrl !== '') {
      put({
        serverName: 'vteam',
        transport: 'streamable-http',
        url: this.options.platformMcpUrl,
        ...(this.options.platformMcpHeaders === undefined
          ? {}
          : { headers: this.options.platformMcpHeaders }),
        toolCallTimeoutMs: resolveVteamMcpTimeoutMs(),
        // 平台 MCP 是 vteam 核心工具面（submit_artifact/group_post/…）：启动失败必须暴露，
        // 否则 agent 会"看起来能跑但所有协作工具都消失"，排查成本极高。
        failOnStartupError: true,
      });
    }

    // ② 平台注册表（本次修复的核心）
    const registryMounts = await this.fetchRegistryMounts();
    for (const mount of registryMounts) {
      put(mount);
    }

    // ③ worker 内置工具 MCP
    if (this.options.toolMcpCommand !== undefined) {
      put({
        serverName: 'vteam-tools',
        transport: 'stdio',
        command: this.options.toolMcpCommand.command,
        args: this.options.toolMcpCommand.args,
        ...(this.options.toolMcpCommand.env === undefined
          ? {}
          : { env: this.options.toolMcpCommand.env }),
        // 工具面缺失可降级（agent 仍能对话/写文件），不阻断启动
        failOnStartupError: false,
      });
    }

    // 快照里已经排好序的 MCP 声明（若调用方直接给了，也要落进去）：
    // 引擎无关快照是本模块的**契约输入**，只认 options 会让 `apply(snapshot)` 的
    // 语义变成"snapshot 只用来取凭据"——那正是 dsh 注入器此前的实际行为。
    for (const spec of snapshot.mcpServers ?? []) {
      put(this.fromSnapshotSpec(spec));
    }

    return [...byName.values()];
  }

  /** 引擎无关快照里的 MCP 声明 → patch 挂载。 */
  private fromSnapshotSpec(spec: EngineMcpServerSpec): DshMcpMount {
    const isHttp = spec.transport === 'streamable-http';
    return {
      serverName: spec.name,
      transport: isHttp ? 'streamable-http' : 'stdio',
      ...(spec.command === undefined ? {} : { command: spec.command }),
      ...(spec.args === undefined ? {} : { args: spec.args }),
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...(spec.url === undefined ? {} : { url: spec.url }),
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      // 与注册表路径同规则：**只有内置 vteam 硬失败**。其余条目若设 true，
      // dsh 的 loader 会因一条不可达的 MCP 拒绝启动整个运行时（见 recordToMount）。
      failOnStartupError: spec.name === VTEAM_MCP_SERVER_NAME,
    };
  }

  /**
   * 拉取平台「MCP 服务器」注册表并映射成挂载。
   *
   * 与 opencode 注入器**同口径**：`GET /api/v1/mcp-servers?enabled=true&page&pageSize`
   * （分页循环到 total），带 `X-Worker-Token` + `x-worker-id`（server 据此把内置
   * `vteam` 的 url 覆盖成该 worker 可达的地址）。
   *
   * 失败策略：**抛错给调用方**（`applyNow` 失败 → 调用方保留旧 patch），
   * 不静默产出"少几个 MCP"的 patch —— 静默少几条正是本次问题的形态。
   */
  private async fetchRegistryMounts(): Promise<DshMcpMount[]> {
    const registry = this.options.mcpRegistry;
    if (registry === undefined) {
      return [];
    }
    const base = registry.serverUrl.replace(/\/+$/, '');
    if (base === '') {
      return [];
    }
    const fetchImpl = registry.fetchImpl ?? globalThis.fetch;
    const records: McpServerRecord[] = [];
    for (let page = 1; ; page += 1) {
      const url =
        `${base}/api/v1/mcp-servers?enabled=true&page=${page}` +
        `&pageSize=${DSH_MCP_REGISTRY_PAGE_SIZE}`;
      const response = await fetchImpl(url, {
        headers: {
          [WORKER_TOKEN_HEADER]: registry.workerToken,
          'x-worker-id': registry.workerId,
        },
      });
      if (!response.ok) {
        throw new Error(
          `[engine/dsh] /mcp-servers 拉取失败: HTTP ${response.status} ${response.statusText}`,
        );
      }
      const payload = (await response.json()) as { items?: unknown[]; total?: unknown };
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        records.push(item as McpServerRecord);
      }
      const total = typeof payload.total === 'number' ? payload.total : records.length;
      if (items.length === 0 || page * DSH_MCP_REGISTRY_PAGE_SIZE >= total) {
        break;
      }
    }

    const mounts: DshMcpMount[] = [];
    for (const record of records) {
      const mount = this.recordToMount(record);
      if (mount === undefined) {
        this.logger.warn(
          `[engine/dsh] MCP 服务器 ${record.name} 配置不完整（type=${record.type}），跳过`,
        );
        continue;
      }
      mounts.push(mount);
    }
    return mounts;
  }

  /**
   * 平台 MCP 记录 → patch 挂载（字段映射与 opencode 注入器一致，见 `buildMcpEntry`）。
   *
   * 关键差异（dsh-mcp-client 的 Config 形态）：
   * - local：platform 的 `command.command` 是**数组**（首元为可执行文件），
   *   而 dsh 是 `command` + `args[]` 两个字段 ⇒ 必须拆开；
   * - remote：`headers` 要解析 `{env:...}` 模板（否则把字面量模板发出去 ⇒ 401）；
   * - 两型都带 `toolCallTimeoutMs`：平台长任务工具（secret_command 855s）会被
   *   dsh 缺省的 60s 掐断。
   */
  private recordToMount(record: McpServerRecord): DshMcpMount | undefined {
    const isVteam = record.name === VTEAM_MCP_SERVER_NAME;
    // 平台超时口径：vteam 用固定下限（clamp），其余用记录自带的值
    const timeoutMs = isVteam
      ? resolveVteamMcpTimeoutMs()
      : typeof record.timeout === 'number' && record.timeout > 0
        ? record.timeout
        : typeof record.command?.timeout === 'number' && record.command.timeout > 0
          ? record.command.timeout
          : undefined;

    if (record.type === 'local') {
      const parts = Array.isArray(record.command?.command) ? record.command?.command : [];
      const bin = parts[0];
      if (typeof bin !== 'string' || bin.trim() === '') {
        return undefined;
      }
      const env = this.stringRecord(record.command?.environment);
      return {
        serverName: record.name,
        transport: 'stdio',
        command: bin,
        args: parts.slice(1).map((a) => String(a)),
        ...(env === undefined ? {} : { env }),
        ...(typeof record.command?.cwd === 'string' && record.command.cwd !== ''
          ? { cwd: record.command.cwd }
          : {}),
        ...(timeoutMs === undefined ? {} : { toolCallTimeoutMs: timeoutMs }),
        // 只有**内置 vteam**（平台核心工具面）才让启动失败硬失败；第三方 MCP 一律软失败。
        // 见下方 remote 分支的说明（failOnStartupError 是"整棵树"级别的开关）。
        failOnStartupError: isVteam,
      };
    }

    if (record.type === 'remote') {
      const url = (record.url ?? '').trim();
      if (url === '') {
        return undefined;
      }
      const headers = stringifyMcpHeaders(
        resolveMcpHeaders(record.headers ?? undefined, {
          workerId: this.options.mcpRegistry?.workerId ?? '',
          workerToken: this.options.mcpRegistry?.workerToken ?? '',
        }),
      );
      return {
        serverName: record.name,
        transport: 'streamable-http',
        url,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(timeoutMs === undefined ? {} : { toolCallTimeoutMs: timeoutMs }),
        // ⚠️ **只有内置 vteam 才硬失败**（实测 2026-11-20）：
        // `failOnStartupError: true` 会让 dsh 的 loader **整个运行时拒绝启动**
        // （`plugin tree failed to load: ... initial connection or tool synchronization failed`）。
        // 平台上任意一条第三方 MCP 不可达（DNS 失败/服务下线/内网地址）就会把
        // **整台 worker 拖死** ⇒ agent 连对话都跑不起来，比"少几个工具"严重得多。
        // vteam 是平台核心工具面（submit_artifact/group_post/…），它不通则 agent 只会
        // "假装在工作"，故保留硬失败；其余条目一律软失败（工具缺了但运行时活着，
        // 日志里有连接错误可查）。
        failOnStartupError: isVteam,
      };
    }

    return undefined;
  }

  /** 任意 JSON → string 字典（非字符串值丢弃：dsh 的 env 是 `z.dict(String)`）。 */
  private stringRecord(value: unknown): Record<string, string> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string') {
        out[key] = raw;
      }
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
}

/**
 * dsh 的 `CredentialApplier` 实现。
 *
 * 产物 = **环境变量映射**（不写盘）。由 worker 在 spawn 子进程时注入。
 */
export class DshCredentialApplier implements CredentialApplier {
  readonly kind: WorkerEngineKind = 'dsh';

  private readonly env: Record<string, string> = {};
  private readonly logger: { info(m: string): void; warn(m: string): void; error(m: string): void };

  constructor(logger?: { info(m: string): void; warn(m: string): void; error(m: string): void }) {
    this.logger = logger ?? console;
  }

  /** 应用凭据（幂等：同 providerID 覆盖）。 */
  async apply(credentials: EngineModelCredential[]): Promise<void> {
    for (const cred of credentials) {
      this.env[credentialEnvName(cred.providerID)] = cred.apiKey;
      if (cred.baseUrl !== undefined && cred.baseUrl !== '') {
        this.env[baseUrlEnvName(cred.providerID)] = cred.baseUrl;
      }
    }
    // 只报告数量与变量名，**绝不打印值**
    this.logger.info(
      `[engine/dsh] 已应用 ${credentials.length} 条模型凭据（env: ${credentials
        .map((c) => credentialEnvName(c.providerID))
        .join(', ')}）`,
    );
  }

  /** 清理凭据。 */
  async clear(providerIDs?: string[]): Promise<void> {
    if (providerIDs === undefined) {
      for (const key of Object.keys(this.env)) delete this.env[key];
      return;
    }
    for (const providerID of providerIDs) {
      delete this.env[credentialEnvName(providerID)];
      delete this.env[baseUrlEnvName(providerID)];
    }
  }

  /** 当前环境变量映射（供驱动 spawn 时合并；**含明文，禁止写日志/落盘**）。 */
  get envVars(): Record<string, string> {
    return { ...this.env };
  }
}

/**
 * 从注入快照解析出 dsh 的默认模型路由。
 *
 * DSH 的模型在 `initialize` 时固定（整进程），故必须从凭据快照里选一条作为默认：
 * 优先 `deepseek-official`，否则取第一条。
 */
export function resolveDefaultRoute(
  credentials: EngineModelCredential[],
): { provider: string; model: string } | undefined {
  if (credentials.length === 0) return undefined;
  const preferred =
    credentials.find((c) => c.providerID === 'deepseek-official') ?? credentials[0];
  return {
    provider: preferred.providerID,
    model: preferred.modelID ?? 'deepseek-v4-flash',
  };
}
