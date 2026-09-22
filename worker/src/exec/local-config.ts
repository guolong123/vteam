/**
 * 独立模式（WORKER_STANDALONE）本地配置下推：外部系统经执行端点直接写 worker 配置，
 * 不经控制面（无注册/心跳/资源拉取）。
 *
 * 端点（仅独立模式挂载，见 exec-server.ts）：
 *   POST /config/skills | /config/tools | /config/mcp-servers | /config/agent-policies
 *   POST /config/model-credentials | /config/git-credentials
 *
 * 语义：**声明式替换**——每类资源本次请求即完整集合（传空数组清空）。写后不自动重启，
 * 响应 restart:'required' 提示调用方按需触发 POST /config/restart。
 */

import * as fs from 'fs';

import {
  DEFAULT_OPENCODE_CONFIG_PATH,
  ModelCredentialEntry,
  ModelProviderConfigEntry,
  buildProviderSection,
  writeAuthJson,
  writeOpencodeConfig,
} from '../credentials/model-credential-injector';
import { GitCredentialEntry, writeGitCredsFile } from '../git/git-credential-injector';
import {
  AgentPolicyDefinition,
  AgentPoliciesResponse,
  buildAgentDefinitions,
} from '../resources/opencode-config-builder';
import {
  McpServerRecord,
  ResolvedSkill,
  ResourceInjector,
  ToolRecord,
} from '../resources/injector';

/** 本地配置下推的入参/校验错误（exec-server 映射为 HTTP 400）。 */
export class LocalConfigError extends Error {}

/** 支持的配置类别（HTTP 路径 /config/<kind> 的合法取值）。 */
export const LOCAL_CONFIG_KINDS = [
  'skills',
  'tools',
  'mcp-servers',
  'agent-policies',
  'model-credentials',
  'git-credentials',
] as const;

export type LocalConfigKind = (typeof LOCAL_CONFIG_KINDS)[number];

export interface LocalConfigResult {
  written: Record<string, unknown>;
  restart: 'required' | 'not-required';
}

export interface LocalConfigApplierOptions {
  injector: ResourceInjector;
  logger?: { info?(message: string): void; warn?(message: string): void };
}

/** 技能名即目录名（路径穿越唯一防线）：字母数字开头，仅含字母数字/`_`.`-`。 */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function requireArray(body: unknown, field: string): unknown[] {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(value)) {
    throw new LocalConfigError(`缺少数组字段 ${field}`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LocalConfigError(`${label} 必须为非空字符串`);
  }
  return value;
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export class LocalConfigApplier {
  private readonly injector: ResourceInjector;
  private readonly logger?: LocalConfigApplierOptions['logger'];

  constructor(options: LocalConfigApplierOptions) {
    this.injector = options.injector;
    this.logger = options.logger;
  }

  /** 按类别分派（HTTP 路径 /config/<kind>）。 */
  apply(kind: LocalConfigKind, body: unknown): LocalConfigResult {
    switch (kind) {
      case 'skills':
        return this.applySkills(body);
      case 'tools':
        return this.applyTools(body);
      case 'mcp-servers':
        return this.applyMcpServers(body);
      case 'agent-policies':
        return this.applyAgentPolicies(body);
      case 'model-credentials':
        return this.applyModelCredentials(body);
      case 'git-credentials':
        return this.applyGitCredentials(body);
    }
  }

  applySkills(body: unknown): LocalConfigResult {
    const records: ResolvedSkill[] = requireArray(body, 'skills').map((item, i) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      const name = requireString(rec.name, `skills[${i}].name`);
      if (!SKILL_NAME_RE.test(name)) {
        throw new LocalConfigError(
          `skills[${i}].name 非法（字母数字开头，仅含字母数字._-）：${name}`,
        );
      }
      return { name, content: requireString(rec.content, `skills[${i}].content`) };
    });
    const names = this.injector.applySkills(records);
    this.logger?.info?.(`[exec] /config/skills -> ${names.length} 项`);
    return { written: { skills: names }, restart: 'required' };
  }

  applyTools(body: unknown): LocalConfigResult {
    const records: ToolRecord[] = requireArray(body, 'tools').map((item, i) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      const action = requireString(rec.action, `tools[${i}].action`);
      const execution = requireString(rec.execution, `tools[${i}].execution`);
      return {
        id: typeof rec.id === 'string' ? rec.id : action,
        action,
        name: typeof rec.name === 'string' && rec.name ? rec.name : action,
        execution,
        schema: (rec.schema ?? null) as Record<string, unknown> | null,
      };
    });
    const actions = this.injector.applyTools(records);
    this.logger?.info?.(`[exec] /config/tools -> ${actions.length} 项`);
    return { written: { tools: actions }, restart: 'required' };
  }

  applyMcpServers(body: unknown): LocalConfigResult {
    const records: McpServerRecord[] = requireArray(body, 'mcpServers').map((item, i) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      const name = requireString(rec.name, `mcpServers[${i}].name`);
      const type = requireString(rec.type, `mcpServers[${i}].type`);
      if (type !== 'local' && type !== 'remote') {
        throw new LocalConfigError(
          `mcpServers[${i}].type 仅支持 local|remote，收到 ${type}`,
        );
      }
      return {
        id: typeof rec.id === 'string' ? rec.id : name,
        name,
        type,
        command: (rec.command ?? null) as McpServerRecord['command'],
        url: typeof rec.url === 'string' ? rec.url : null,
        headers: (rec.headers ?? null) as McpServerRecord['headers'],
        oauth: rec.oauth ?? null,
        enabled: rec.enabled !== false,
      };
    });
    const names = this.injector.applyMcpServers(records);
    this.logger?.info?.(`[exec] /config/mcp-servers -> ${names.length} 项`);
    return { written: { mcpServers: names }, restart: 'required' };
  }

  applyAgentPolicies(body: unknown): LocalConfigResult {
    const agents = requireArray(body, 'agents').map(
      (item) => (item ?? {}) as AgentPolicyDefinition,
    );
    try {
      buildAgentDefinitions(agents);
    } catch (err) {
      throw new LocalConfigError(err instanceof Error ? err.message : String(err));
    }
    const policies: AgentPoliciesResponse = { agents };
    const result = this.injector.applyAgentPolicies(policies);
    this.logger?.info?.(`[exec] /config/agent-policies -> ${result.names.length} 项`);
    return { written: { agentPolicies: result }, restart: 'required' };
  }

  applyModelCredentials(body: unknown): LocalConfigResult {
    const providerKeys = requireArray(body, 'providerKeys').map((item, i) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        providerID: requireString(rec.providerID, `providerKeys[${i}].providerID`),
        key: requireString(rec.key, `providerKeys[${i}].key`),
      } satisfies ModelCredentialEntry;
    });

    const rawConfigs = (body as Record<string, unknown>).providerConfigs;
    let providerConfigs: Record<string, ModelProviderConfigEntry> | undefined;
    if (rawConfigs !== undefined) {
      if (!rawConfigs || typeof rawConfigs !== 'object' || Array.isArray(rawConfigs)) {
        throw new LocalConfigError('providerConfigs 必须是对象：{providerID: {baseUrl, models}}');
      }
      providerConfigs = rawConfigs as Record<string, ModelProviderConfigEntry>;
    }

    const auth = writeAuthJson(providerKeys);
    let opencodeConfigPath: string | null = null;
    if (providerConfigs !== undefined) {
      const existing = readFileIfExists(DEFAULT_OPENCODE_CONFIG_PATH);
      opencodeConfigPath = writeOpencodeConfig(existing, buildProviderSection(providerConfigs)).path;
    }
    this.logger?.info?.(
      `[exec] /config/model-credentials -> ${providerKeys.length} keys, ${
        Object.keys(providerConfigs ?? {}).length
      } providers`,
    );
    return {
      written: { authJsonPath: auth.authJsonPath, opencodeConfigPath },
      restart: 'required',
    };
  }

  applyGitCredentials(body: unknown): LocalConfigResult {
    const credentials = requireArray(body, 'credentials').map((item, i): GitCredentialEntry => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        repoUrl: requireString(rec.repoUrl, `credentials[${i}].repoUrl`),
        authType: rec.authType === 'https_token' ? 'https_token' : 'ssh_key',
        key: requireString(rec.key, `credentials[${i}].key`),
        fingerprint: typeof rec.fingerprint === 'string' ? rec.fingerprint : '',
        permission: typeof rec.permission === 'string' ? rec.permission : undefined,
      };
    });
    const result = writeGitCredsFile(credentials);
    this.logger?.info?.(`[exec] /config/git-credentials -> ${credentials.length} 项`);
    return { written: { gitCredsPath: result.path }, restart: 'not-required' };
  }
}
