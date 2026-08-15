/**
 * T4b 资源注入执行器：worker 从控制面拉取三类资源并注入本地 opencode 配置目录。
 *
 * - injectSkills()：GET /skills（enabled=true）→ 逐个 GET /skills/:id/content →
 *   写 <workDir>/.opencode/skills/<name>/SKILL.md（serve 启动时 discoverSkills 扫描）
 * - injectTools()：GET /tools（enabled=true）→ 渲染 renderCustomToolFile →
 *   写 <workDir>/.opencode/tools/<action>.ts（默认导出，工具名 = action = 权限点 FR-48）
 * - injectMcp()：GET /mcp-servers（enabled=true）→ 生成 <workDir>/opencode.json 的
 *   mcp 节（合并保留其他配置节，11 篇 §5.1 格式）
 * - injectAll()：三者组合，供 T4a 命令回调与 worker 启动前调用
 *
 * 鉴权：所有拉取带 X-Worker-Token（与注册/心跳同 token，对齐 server WorkerOrJwtGuard）。
 * 清理：停用资源的残留文件经 manifest（<workDir>/.opencode-worker-inject.json）比对后
 * 删除——只删本注入器写过的文件，不误伤 git.ts（内置注入）与用户文件。
 *
 * worker 独立进程铁律：不 import server 代码（apiUrl/WORKER_TOKEN_HEADER 复用 registry-client 常量）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { apiUrl, WORKER_TOKEN_HEADER } from '../client/registry-client';
import {
  CustomToolArg,
  CustomToolArgType,
  CustomToolFileDef,
  renderCustomToolFile,
} from './custom-tool';

/** 注入器日志接口（默认 console，测试可静默）。 */
export interface ResourceLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface ResourceInjectorOptions {
  /** server 基址（如 http://localhost:3000）。 */
  serverUrl: string;
  /** X-Worker-Token 鉴权 token（config.workerToken）。 */
  workerToken: string;
  /** worker 全局唯一 id（config.workerId；拉取时带 x-worker-id，server 按 worker 覆盖内置 MCP 地址）。 */
  workerId: string;
  /** opencode serve 工作目录（注入落点根）。 */
  workDir: string;
  /** fetch 注入点（测试用）；默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  logger?: ResourceLogger;
}

export interface InjectReport {
  skills: string[];
  tools: string[];
  mcpServers: string[];
}

/** 控制面资源记录最小形态（来自 GET /skills、/tools、/mcp-servers）。 */
interface SkillRecord {
  id: string;
  name: string;
}
interface ToolRecord {
  id: string;
  action: string;
  name: string;
  execution: string;
  schema: Record<string, unknown> | null;
}
interface McpServerRecord {
  id: string;
  name: string;
  type: string;
  command: { command?: string[]; cwd?: string; environment?: unknown; timeout?: number } | null;
  url: string | null;
  headers: Record<string, string> | null;
  oauth: unknown;
  enabled?: boolean;
  /** remote 顶层可选超时（11 §5.1 remote 字段含 timeout?；服务端当前模型未提供，兼容预留）。 */
  timeout?: number;
}

/** manifest 键：记录上次注入的文件/目录名，用于停用资源清理。 */
interface InjectManifest {
  skills?: string[];
  tools?: string[];
  mcpServers?: string[];
}

const MANIFEST_REL = '.opencode-worker-inject.json';
const DEFAULT_PAGE_SIZE = 100;
/** tools 注入文件名非法字符（opencode 工具名约束，安全兜底）。 */
const INVALID_FILE_CHARS = /[^a-z0-9-_.]/g;

export class ResourceInjector {
  private readonly serverUrl: string;
  private readonly workerToken: string;
  private readonly workerId: string;
  private readonly workDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: ResourceLogger;

  constructor(options: ResourceInjectorOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.workerToken = options.workerToken;
    this.workerId = options.workerId;
    this.workDir = options.workDir;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
  }

  /** 注入全部三类资源，返回报告。 */
  async injectAll(): Promise<InjectReport> {
    const [skills, tools, mcpServers] = await Promise.all([
      this.injectSkills(),
      this.injectTools(),
      this.injectMcp(),
    ]);
    return { skills, tools, mcpServers };
  }

  /** 注入启用技能：<workDir>/.opencode/skills/<name>/SKILL.md。返回注入的 skill 名。 */
  async injectSkills(): Promise<string[]> {
    const skills = await this.fetchAll<SkillRecord>('/skills', { enabled: 'true' });
    const names: string[] = [];
    for (const skill of skills) {
      try {
        const content = await this.fetchSkillContent(skill.id);
        if (content === null) {
          this.logger?.warn?.(`[inject] 技能 ${skill.id} content 拉取失败，跳过`);
          continue;
        }
        const skillDir = path.join(this.workDir, '.opencode', 'skills', skill.name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
        names.push(skill.name);
      } catch (err) {
        this.logger?.warn?.(
          `[inject] 技能 ${skill.id}（${skill.name}）注入失败: ${(err as Error).message}`,
        );
      }
    }
    this.cleanupByManifest('skills', names);
    return names;
  }

  /** 注入启用工具：<workDir>/.opencode/tools/<action>.ts。返回注入的 action 列表（mcp 型除外）。 */
  async injectTools(): Promise<string[]> {
    const tools = await this.fetchAll<ToolRecord>('/tools', { enabled: 'true' });
    const writtenFiles: string[] = [];
    const actions: string[] = [];
    for (const tool of tools) {
      if (tool.execution === 'mcp') {
        // MCP 工具不渲染为自定义工具文件——由 T8b 经 mcp-servers 配置节注入
        continue;
      }
      const def = this.buildToolDef(tool);
      if (!def) {
        this.logger?.warn?.(
          `[inject] 工具 ${tool.action} 缺少执行细节（execution=${tool.execution}），跳过注入`,
        );
        continue;
      }
      const fileName = `${def.fileName}.ts`;
      const filePath = path.join(this.workDir, '.opencode', 'tools', fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, renderCustomToolFile(def), 'utf8');
      writtenFiles.push(fileName);
      actions.push(tool.action);
    }
    this.cleanupByManifest('tools', writtenFiles);
    return actions;
  }

  /**
   * 注入 MCP 服务器：<workDir>/opencode.json 的 mcp 节（合并保留其他节）。
   * - 注入启用服务器（local/remote 两型，11 篇 §5.1 格式）
   * - manifest 比对清理：上次注入过、本次不在启用集的条目从 mcp 节移除；
   *   用户手动配置的条目（不在 manifest 中）保留不误删
   * 返回注入的服务器名。
   */
  async injectMcp(): Promise<string[]> {
    const servers = await this.fetchAll<McpServerRecord>('/mcp-servers', {
      enabled: 'true',
    });
    const configPath = path.join(this.workDir, 'opencode.json');
    const config = this.readConfig(configPath);

    // manifest 记录过的名 = 注入器管理域：不在本次启用集的移除；未记录过的（用户手动）保留
    const manifest = this.readManifest();
    const previouslyInjected = manifest.mcpServers ?? [];

    const mcp: Record<string, unknown> = {};
    const existingMcp = this.readMcpSection(config);
    for (const name of Object.keys(existingMcp)) {
      if (!previouslyInjected.includes(name)) {
        mcp[name] = existingMcp[name];
      }
    }

    const names: string[] = [];
    for (const server of servers) {
      const entry = this.buildMcpEntry(server);
      if (!entry) {
        this.logger?.warn?.(
          `[inject] MCP 服务器 ${server.name} 配置不完整（type=${server.type}），跳过`,
        );
        continue;
      }
      mcp[server.name] = entry;
      names.push(server.name);
    }
    config.mcp = mcp;
    this.writeConfig(configPath, config);
    this.writeManifest({ ...manifest, mcpServers: names });
    return names;
  }

  // ------------------------------------------------------------------
  // 私有：控制面拉取
  // ------------------------------------------------------------------

  private async getJson<T>(pathname: string, query: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    const url = apiUrl(this.serverUrl, `${pathname}?${qs}`);
    const response = await this.fetchImpl(url, {
      headers: {
        [WORKER_TOKEN_HEADER]: this.workerToken,
        // 携带 worker 身份：server 按 worker.capabilities.mcpUrl 覆盖内置 keta-platform 地址
        'x-worker-id': this.workerId,
      },
    });
    if (!response.ok) {
      throw new Error(
        `资源拉取失败: HTTP ${response.status} ${response.statusText} (${pathname})`,
      );
    }
    return (await response.json()) as T;
  }

  /** 分页拉取全部记录（pageSize=100 循环至 total）。 */
  private async fetchAll<T>(pathname: string, query: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const data = await this.getJson<{ items: T[]; total: number }>(pathname, {
        ...query,
        page: String(page),
        pageSize: String(DEFAULT_PAGE_SIZE),
      });
      items.push(...data.items);
      if (data.items.length === 0 || page * DEFAULT_PAGE_SIZE >= data.total) {
        break;
      }
    }
    return items;
  }

  /** GET /skills/:id/content → SKILL.md 全文；404/失败返回 null（调用方跳过）。 */
  private async fetchSkillContent(id: string): Promise<string | null> {
    const response = await this.fetchImpl(
      apiUrl(this.serverUrl, `/skills/${encodeURIComponent(id)}/content`),
      { headers: { [WORKER_TOKEN_HEADER]: this.workerToken } },
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { content?: unknown };
    return typeof data.content === 'string' ? data.content : null;
  }

  // ------------------------------------------------------------------
  // 私有：tools 定义构造
  // ------------------------------------------------------------------

  /** 从 DB tool 记录构造渲染定义；执行细节缺失返回 null（调用方跳过）。 */
  private buildToolDef(tool: ToolRecord): CustomToolFileDef | null {
    const execute = this.resolveExecution(tool);
    if (!execute) {
      return null;
    }
    return {
      fileName: this.sanitizeFileName(tool.action),
      exports: [
        {
          // 默认导出：工具名 = 文件名 = action（FR-48 工具名即权限 action）
          exportName: 'default',
          description: tool.name || tool.action,
          args: schemaToArgs(tool.schema),
          execute,
        },
      ],
    };
  }

  /**
   * 解析 execution 渲染源。优先读取输入 schema 的约定扩展字段 `x-execution`
   * （`{command?|url/method/headers?|code}`，由工具注册侧写入）；缺失时返回 null
   * → 调用方跳过注入（未配置完整执行细节的工具不暴露给模型）。
   */
  private resolveExecution(
    tool: ToolRecord,
  ): CustomToolFileDef['exports'][number]['execute'] | null {
    const xExec = readXExecution(tool.schema);

    switch (tool.execution) {
      case 'cli': {
        const command =
          xExec && Array.isArray(xExec.command) && xExec.command.length > 0
            ? xExec.command.map(String)
            : undefined;
        if (!command) {
          return null;
        }
        return { type: 'cli', command };
      }
      case 'http': {
        const url = xExec && typeof xExec.url === 'string' ? xExec.url : undefined;
        if (!url) {
          return null;
        }
        const method =
          xExec && typeof xExec.method === 'string' ? xExec.method.toUpperCase() : 'POST';
        const headers =
          xExec && typeof xExec.headers === 'object' && xExec.headers !== null
            ? (xExec.headers as Record<string, string>)
            : undefined;
        return { type: 'http', url, method, headers };
      }
      case 'code': {
        const code = xExec && typeof xExec.code === 'string' ? xExec.code : undefined;
        if (!code) {
          return null;
        }
        return { type: 'code', code };
      }
      default:
        // 未知 execution（非 code/cli/http/mcp）不渲染
        return null;
    }
  }

  private sanitizeFileName(action: string): string {
    const cleaned = action.replace(INVALID_FILE_CHARS, '-').replace(/^\.+|\.+$/g, '');
    return cleaned || 'tool';
  }

  // ------------------------------------------------------------------
  // 私有：MCP 配置节构造
  // ------------------------------------------------------------------

  /** 按 local/remote 构造 opencode mcp 节（11 篇 §5.1）；配置不完整返回 null。 */
  private buildMcpEntry(server: McpServerRecord): Record<string, unknown> | null {
    if (server.type === 'local') {
      const command = server.command?.command;
      if (!Array.isArray(command) || command.length === 0) {
        return null;
      }
      const entry: Record<string, unknown> = { type: 'local', command };
      if (server.command?.cwd) entry.cwd = server.command.cwd;
      if (server.command?.environment) entry.environment = server.command.environment;
      if (typeof server.command?.timeout === 'number') entry.timeout = server.command.timeout;
      entry.enabled = server.enabled !== false;
      return entry;
    }
    if (server.type === 'remote') {
      if (!server.url) {
        return null;
      }
      const entry: Record<string, unknown> = { type: 'remote', url: server.url };
      if (server.headers) entry.headers = server.headers;
      if (server.oauth !== undefined && server.oauth !== null) {
        entry.oauth = server.oauth;
      }
      if (typeof server.timeout === 'number') entry.timeout = server.timeout;
      entry.enabled = server.enabled !== false;
      return entry;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 私有：opencode.json 与 manifest 读写
  // ------------------------------------------------------------------

  private readConfig(configPath: string): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // 不存在或非法 JSON：从空配置合并
      return {};
    }
  }

  /** 读取配置的 mcp 节（非对象/数组时返回空对象）。 */
  private readMcpSection(config: Record<string, unknown>): Record<string, unknown> {
    const mcp = config.mcp;
    return mcp && typeof mcp === 'object' && !Array.isArray(mcp)
      ? (mcp as Record<string, unknown>)
      : {};
  }

  private writeConfig(configPath: string, config: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  private readManifest(): InjectManifest {
    try {
      const raw = fs.readFileSync(this.manifestPath(), 'utf8');
      const parsed = JSON.parse(raw) as InjectManifest;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeManifest(manifest: InjectManifest): void {
    fs.writeFileSync(this.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  private manifestPath(): string {
    return path.join(this.workDir, MANIFEST_REL);
  }

  /**
   * 停用资源清理：删除 manifest 中记录过、但本次不在启用集的注入文件/目录。
   * 只操作 manifest 记录过的路径——git.ts（内置 installGitTools 注入）与用户手动
   * 文件不在 manifest 中，不会被误删。无论是否有删除动作都更新 manifest 为最新注入集。
   */
  private cleanupByManifest(kind: keyof InjectManifest, current: string[]): void {
    const manifest = this.readManifest();
    const previous = manifest[kind] ?? [];
    const removed = previous.filter((p) => !current.includes(p));
    if (removed.length > 0) {
      if (kind === 'skills') {
        for (const name of removed) {
          fs.rmSync(path.join(this.workDir, '.opencode', 'skills', name), {
            recursive: true,
            force: true,
          });
        }
      } else {
        for (const file of removed) {
          fs.rmSync(path.join(this.workDir, '.opencode', 'tools', file), { force: true });
        }
      }
    }
    this.writeManifest({ ...manifest, [kind]: current });
  }
}

// ------------------------------------------------------------------
// 模块级工具函数（导出供 spec 断言）
// ------------------------------------------------------------------

/** 从输入 schema 提取约定执行细节扩展字段（x-execution）。 */
export function readXExecution(
  schema: Record<string, unknown> | null | undefined,
): { command?: unknown; url?: unknown; method?: unknown; headers?: unknown; code?: unknown } | null {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  const x = schema['x-execution'];
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
}

/** JSON Schema（properties + required）→ CustomToolArg[]。 */
export function schemaToArgs(
  schema: Record<string, unknown> | null | undefined,
): CustomToolArg[] {
  if (!schema || typeof schema !== 'object') {
    return [];
  }
  const properties = schema.properties as
    | Record<string, { type?: unknown; description?: unknown }>
    | undefined;
  if (!properties || typeof properties !== 'object') {
    return [];
  }
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  return Object.entries(properties).map(([name, prop]) => {
    const p = prop && typeof prop === 'object' ? prop : {};
    const rawType = typeof p.type === 'string' ? p.type : 'string';
    const type: CustomToolArgType =
      rawType === 'boolean'
        ? 'boolean'
        : rawType === 'integer' || rawType === 'number'
          ? 'integer'
          : 'string';
    return {
      name,
      type,
      required: required.includes(name),
      description: typeof p.description === 'string' ? p.description : '',
    };
  });
}
