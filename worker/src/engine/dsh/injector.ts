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

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  EngineConfigSnapshot,
  EngineModelCredential,
  CredentialApplier,
  ResourceInjector,
  WorkerEngineKind,
} from '../types';
import { buildDshPatch, type DshMcpMount, type DshProviderRoute } from './patch-builder';

/** patch 文件名（落在 workDir 的 `.vteam/` 下，避免污染引擎私有目录）。 */
export const DSH_PATCH_FILENAME = 'dsh-profile.patch.yml';

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

  constructor(options: DshInjectorOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? console;
  }

  /**
   * 应用注入快照 → 写 patch 文件。
   *
   * @param snapshot - 引擎无关快照（skills/tools/mcp/agentPolicies/credentials）。
   * @param workDir - 注入根（vteam 资产目录由此派生）。
   * @returns patch 文件绝对路径（供驱动 spawn 时 --patch 引用）。
   */
  async apply(snapshot: EngineConfigSnapshot, workDir: string): Promise<string> {
    const patchPath = path.join(workDir, '.vteam', DSH_PATCH_FILENAME);
    const providers = snapshot.modelCredentials.map((cred) => this.toProviderRoute(cred));
    const mcpMounts = this.buildMounts(snapshot);

    const content = buildDshPatch({
      providers,
      mcpMounts,
      ...(this.options.providerApi !== undefined ? {} : {}),
    });

    await fs.promises.mkdir(path.dirname(patchPath), { recursive: true });
    // 原子写：先写临时文件再 rename（避免 dsh 读到半个文件导致启动失败）
    const tmp = `${patchPath}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, patchPath);

    this.logger.info(
      `[engine/dsh] patch 已写入 ${patchPath}（providers=${providers.length}, mcp=${mcpMounts.length}）`,
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
    return {
      route: cred.providerID,
      apiKeyEnv: credentialEnvName(cred.providerID),
      api,
      baseURL,
      models: [
        {
          id: cred.modelID ?? 'deepseek-v4-flash',
          name: cred.modelID ?? 'deepseek-v4-flash',
        },
      ],
    };
  }

  /** 构造 MCP 挂载清单（平台 MCP + 工具 MCP）。 */
  private buildMounts(_snapshot: EngineConfigSnapshot): DshMcpMount[] {
    const mounts: DshMcpMount[] = [];

    if (this.options.platformMcpUrl !== undefined && this.options.platformMcpUrl !== '') {
      mounts.push({
        serverName: 'vteam',
        transport: 'streamable-http',
        url: this.options.platformMcpUrl,
        ...(this.options.platformMcpHeaders === undefined
          ? {}
          : { headers: this.options.platformMcpHeaders }),
        // 平台 MCP 是 vteam 核心工具面（submit_artifact/group_post/…）：启动失败必须暴露，
        // 否则 agent 会"看起来能跑但所有协作工具都消失"，排查成本极高。
        failOnStartupError: true,
      });
    }

    if (this.options.toolMcpCommand !== undefined) {
      mounts.push({
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

    return mounts;
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
